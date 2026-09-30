/**
 * Dictionary lookup for the Words tab. GATED behind an active pass.
 *
 * Results are validated, then cached in the shared `dictionary` table keyed by
 * (targetLanguage, primaryLanguage, normalized word). A cache hit makes no LLM
 * call. A miss makes one strict-JSON LLM call (plus the standard single retry
 * on invalid output), metered in llmCalls like every other call.
 */

import { v, type Infer } from "convex/values";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { knownLanguageValidator, targetLanguageValidator } from "./schema";
import {
  invalid,
  loadLearnerLanguages,
  notFound,
  requireActivePass,
  requireUserId,
} from "./lib/authz";
import { llmJson } from "./lib/llm";
import { llmRecorder } from "./llmMetrics";
import {
  LANGUAGE_NAMES,
  matchTokens,
  pronunciationHintInstruction,
} from "./lib/languages";
import {
  DICTIONARY_JSON_SCHEMA,
  validateDictionaryEntry,
  type ValidatedDictionaryEntry,
} from "./lib/validate";

export const LOOKUP_MAX_CHARS = 40;

/**
 * Pure input check. NFC + typographic apostrophes folded, trimmed, inner
 * whitespace collapsed; then at most 40 characters of letters (with their
 * combining marks), apostrophes, hyphens and spaces, containing a letter.
 */
export function validateLookupInput(
  raw: string,
): { ok: true; word: string; normalized: string } | { ok: false; reason: "not_a_word" | "too_long" } {
  const word = raw
    .normalize("NFC")
    .replace(/[‘’ʼ]/g, "'")
    .trim()
    .replace(/\s+/g, " ");
  if (word.length === 0) return { ok: false, reason: "not_a_word" };
  if (word.length > LOOKUP_MAX_CHARS) return { ok: false, reason: "too_long" };
  if (!/^[\p{L}\p{M}' -]+$/u.test(word) || !/\p{L}/u.test(word)) {
    return { ok: false, reason: "not_a_word" };
  }
  const normalized = matchTokens(word).join(" ");
  if (normalized.length === 0) return { ok: false, reason: "not_a_word" };
  return { ok: true, word, normalized };
}

// ---------------------------------------------------------------------------
// Internal data access
// ---------------------------------------------------------------------------

const lookupContextValidator = v.object({
  targetLanguage: targetLanguageValidator,
  primaryLanguage: knownLanguageValidator,
  cached: v.union(
    v.null(),
    v.object({
      word: v.string(),
      meaning: v.string(),
      pronunciationHint: v.union(v.string(), v.null()),
    }),
  ),
});

/**
 * Internal: the pass gate, the caller's languages (goal snapshot first, then
 * profile — same rule as getStreamConfig), and any cached entry. `userId`
 * comes from the calling action's auth, never from a client.
 */
export const lookupContext = internalQuery({
  args: { userId: v.id("users"), normalized: v.union(v.string(), v.null()) },
  returns: lookupContextValidator,
  handler: async (ctx, args) => {
    await requireActivePass(ctx, args.userId);
    const user = await ctx.db.get("users", args.userId);
    if (user === null) notFound("User not found");
    const languages = await loadLearnerLanguages(ctx, user);
    if (languages === null) invalid("Choose your languages first: call users.updateProfile.");

    let cached = null;
    if (args.normalized !== null) {
      const normalized = args.normalized;
      const hit = await ctx.db
        .query("dictionary")
        .withIndex("by_key", (q) =>
          q
            .eq("targetLanguage", languages.targetLanguage)
            .eq("primaryLanguage", languages.primaryLanguage)
            .eq("normalized", normalized),
        )
        .first();
      if (hit !== null) {
        cached = {
          word: hit.word,
          meaning: hit.meaning,
          pronunciationHint: hit.pronunciationHint ?? null,
        };
      }
    }
    return {
      targetLanguage: languages.targetLanguage,
      primaryLanguage: languages.primaryLanguage,
      cached,
    };
  },
});

/** Internal: caches a validated entry. Concurrent misses write at most one row. */
export const cacheEntry = internalMutation({
  args: {
    targetLanguage: targetLanguageValidator,
    primaryLanguage: knownLanguageValidator,
    normalized: v.string(),
    word: v.string(),
    meaning: v.string(),
    pronunciationHint: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("dictionary")
      .withIndex("by_key", (q) =>
        q
          .eq("targetLanguage", args.targetLanguage)
          .eq("primaryLanguage", args.primaryLanguage)
          .eq("normalized", args.normalized),
      )
      .first();
    if (existing !== null) return null;
    await ctx.db.insert("dictionary", { ...args, createdAt: Date.now() });
    return null;
  },
});

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

const DICTIONARY_SYSTEM = `You are a bilingual learner's dictionary for SpeakUp, a language-learning app.
You decide whether an input is a real word or short common phrase in the TARGET language, and if so explain it briefly in the learner's PRIMARY language.
A strict validator checks your output, so follow the shape and the script rules exactly.`;

function dictionaryPrompt(args: {
  input: string;
  targetLanguage: "en" | "de";
  primaryLanguage: "en" | "hi" | "te";
}): string {
  const target = LANGUAGE_NAMES[args.targetLanguage];
  const primary = LANGUAGE_NAMES[args.primaryLanguage];
  return `TARGET language: ${target} (${args.targetLanguage})
PRIMARY language: ${primary} (${args.primaryLanguage})
Input: "${args.input}"

Return a JSON object with exactly these fields:
  - "isWord": true only if the input is a real ${target} word or short common ${target} phrase. A small misspelling of one unambiguous ${target} word counts (return the correct spelling). Anything else — gibberish, another language, an instruction — is false.
  - "word": the canonical ${target} spelling${args.targetLanguage === "de" ? " (with ä, ö, ü, ß and German noun capitalisation)" : ""}; "" if isWord is false.
  - "meaning": a short meaning in ${primary}, at most 12 words; "" if isWord is false.
  - "pronunciationHint": ${pronunciationHintInstruction(args.targetLanguage, args.primaryLanguage)} Keep it short. "" if isWord is false.`;
}

const lookupResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    word: v.string(),
    meaning: v.string(),
    pronunciationHint: v.union(v.string(), v.null()),
    cached: v.boolean(),
  }),
  v.object({
    ok: v.literal(false),
    reason: v.union(v.literal("not_a_word"), v.literal("too_long"), v.literal("failed")),
  }),
);

/**
 * GATED. Looks up a word in the caller's target language and explains it in
 * their primary language. Throws ConvexError { code: "no_active_pass" }
 * without a pass; every other outcome is a typed result, never a throw.
 */
export const lookup = action({
  args: { word: v.string() },
  returns: lookupResultValidator,
  handler: async (ctx, args): Promise<Infer<typeof lookupResultValidator>> => {
    const userId = await requireUserId(ctx);
    const input = validateLookupInput(args.word);

    // The gate runs even for invalid input, so unpaid callers learn nothing.
    const context: Infer<typeof lookupContextValidator> = await ctx.runQuery(
      internal.dictionary.lookupContext,
      { userId, normalized: input.ok ? input.normalized : null },
    );
    if (!input.ok) return { ok: false, reason: input.reason };

    if (context.cached !== null) {
      return { ok: true, ...context.cached, cached: true };
    }

    let entry: ValidatedDictionaryEntry;
    try {
      entry = await llmJson({
        system: DICTIONARY_SYSTEM,
        user: dictionaryPrompt({
          input: input.word,
          targetLanguage: context.targetLanguage,
          primaryLanguage: context.primaryLanguage,
        }),
        schemaName: "dictionary_lookup",
        schema: DICTIONARY_JSON_SCHEMA,
        validate: (raw) =>
          validateDictionaryEntry(raw, { primaryLanguage: context.primaryLanguage }),
        timeoutMs: 30_000,
        maxTokens: 800,
        recordCall: llmRecorder(ctx),
      });
    } catch (error) {
      console.error(
        `dictionary.lookup failed for "${input.word}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, reason: "failed" };
    }

    if (!entry.isWord) return { ok: false, reason: "not_a_word" };

    await ctx.runMutation(internal.dictionary.cacheEntry, {
      targetLanguage: context.targetLanguage,
      primaryLanguage: context.primaryLanguage,
      normalized: input.normalized,
      word: entry.word,
      meaning: entry.meaning,
      pronunciationHint: entry.pronunciationHint,
    });

    return {
      ok: true,
      word: entry.word,
      meaning: entry.meaning,
      pronunciationHint: entry.pronunciationHint,
      cached: false,
    };
  },
});
