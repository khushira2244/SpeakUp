/**
 * One-off data backfills. Everything here is internal — invoked through the
 * Convex CLI (`npx convex run migrations:<name>`), never reachable from a
 * client. Both backfills are idempotent: a second run changes nothing.
 *
 * 1. backfillUserLanguages — widen-migrate-narrow step (b) for the language
 *    profile: copies the legacy `users.nativeLanguage` into knownLanguages /
 *    primaryLanguage / targetLanguage and REMOVES the legacy field, so that
 *    step (c) — deleting it from the schema — can deploy.
 *
 * 2. backfillPronunciationHints — gives words generated before hints existed
 *    a pronunciationHint (ONE LLM call per goal, only for words missing one),
 *    stamps the goalTargets language snapshot, and copies hints into the
 *    goal's existing plan deterministically. It never regenerates targets,
 *    level results or plans.
 */

import { v, type Infer } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { knownLanguageValidator, targetLanguageValidator } from "./schema";
import { llmJson } from "./lib/llm";
import { llmRecorder } from "./llmMetrics";
import {
  LANGUAGE_NAMES,
  foldForMatching,
  generationLanguages,
  planLegacyLanguageBackfill,
  pronunciationHintInstruction,
  readLanguageProfile,
} from "./lib/languages";
import { HINT_BACKFILL_JSON_SCHEMA, validateHintBackfill } from "./lib/validate";

// ---------------------------------------------------------------------------
// 1. User language profile (widen-migrate-narrow, step b)
// ---------------------------------------------------------------------------

export const backfillUserLanguagesResult = v.object({
  scanned: v.number(),
  /** Legacy value mapped onto the new profile fields. */
  migrated: v.number(),
  /** Rows the legacy field was removed from (includes every `migrated` row). */
  legacyCleared: v.number(),
  /** Already had a complete new profile. */
  alreadyMigrated: v.number(),
  /** No legacy value and no profile yet: left untouched. */
  unset: v.number(),
  /** Legacy values that map to no supported language (new fields left unset). */
  unsupported: v.array(v.object({ userId: v.id("users"), value: v.string() })),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

/**
 * Processes ONE page of users. Drive it until `isDone`, passing
 * `continueCursor` back as `paginationOpts.cursor`:
 *
 *   npx convex run migrations:backfillUserLanguages '{"paginationOpts":{"numItems":100,"cursor":null}}'
 */
export const backfillUserLanguages = internalMutation({
  args: { paginationOpts: paginationOptsValidator },
  returns: backfillUserLanguagesResult,
  handler: async (ctx, args) => {
    const page = await ctx.db.query("users").paginate(args.paginationOpts);

    let migrated = 0;
    let legacyCleared = 0;
    let alreadyMigrated = 0;
    let unset = 0;
    const unsupported: Array<{ userId: Id<"users">; value: string }> = [];

    for (const user of page.page) {
      // The legacy field is read through a widened type so this code keeps
      // compiling after step (c) removes it from the schema; from then on it
      // is always undefined and every row takes the no-op path.
      const legacyDoc = user as Doc<"users"> & { nativeLanguage?: unknown };
      const legacy = legacyDoc.nativeLanguage;
      const hasProfile = readLanguageProfile(user) !== null;

      if (legacy === undefined) {
        if (hasProfile) alreadyMigrated++;
        else unset++;
        continue;
      }

      // The legacy field must be removed from EVERY row that has it, or step
      // (c) fails schema validation. `replace` drops any field not passed.
      const { _id, _creationTime, nativeLanguage: _legacy, ...rest } = legacyDoc;
      let next: typeof rest = rest;

      if (hasProfile) {
        // Profile already set (e.g. updateProfile ran after the widen deploy):
        // keep it, only drop the stale legacy value.
        alreadyMigrated++;
      } else {
        const plan = planLegacyLanguageBackfill(legacy);
        if (plan.kind === "migrate") {
          next = { ...rest, ...plan.profile };
          migrated++;
        } else if (plan.kind === "unsupported") {
          unsupported.push({ userId: user._id, value: plan.legacyValue });
        }
      }

      await ctx.db.replace("users", user._id, next);
      legacyCleared++;
    }

    return {
      scanned: page.page.length,
      migrated,
      legacyCleared,
      alreadyMigrated,
      unset,
      unsupported,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

// ---------------------------------------------------------------------------
// 2. Pronunciation hints for pre-hint vocabulary
// ---------------------------------------------------------------------------

const hintBackfillInputValidator = v.object({
  found: v.boolean(),
  goalTargetsId: v.union(v.id("goalTargets"), v.null()),
  targetLanguage: targetLanguageValidator,
  primaryLanguage: knownLanguageValidator,
  /** Goal words that have no pronunciationHint yet. */
  missingWords: v.array(v.string()),
});

/** Internal: the active goal's targets for `email`, and which words lack hints. */
export const hintBackfillInput = internalQuery({
  args: { email: v.string() },
  returns: hintBackfillInputValidator,
  handler: async (ctx, args) => {
    const notFound = {
      found: false,
      goalTargetsId: null,
      targetLanguage: "en" as const,
      primaryLanguage: "en" as const,
      missingWords: [],
    };

    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email))
      .first();
    if (user === null) return notFound;

    const goal = await ctx.db
      .query("goals")
      .withIndex("by_user_and_active", (q) => q.eq("userId", user._id).eq("active", true))
      .order("desc")
      .first();
    if (goal === null) return notFound;

    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
      .first();
    if (targets === null) return notFound;

    // Hints must be in the language the MEANINGS were written in: the
    // snapshot's primary language, or for pre-snapshot rows the profile's.
    const languages = generationLanguages(targets, readLanguageProfile(user));

    return {
      found: true,
      goalTargetsId: targets._id,
      targetLanguage: languages.targetLanguage,
      primaryLanguage: languages.primaryLanguage,
      missingWords: targets.words
        .filter((w) => w.pronunciationHint === undefined)
        .map((w) => w.word),
    };
  },
});

/**
 * Internal, deterministic: fills ONLY missing hints (never overwrites one),
 * stamps the language snapshot if absent, and copies goal-word hints into the
 * goal's plan by word. Writes nothing when there is nothing to change.
 */
export const applyPronunciationHints = internalMutation({
  args: {
    goalTargetsId: v.id("goalTargets"),
    hints: v.array(v.object({ word: v.string(), pronunciationHint: v.string() })),
    targetLanguage: targetLanguageValidator,
    primaryLanguage: knownLanguageValidator,
  },
  returns: v.object({
    wordsFilled: v.number(),
    snapshotStamped: v.boolean(),
    planWordsFilled: v.number(),
  }),
  handler: async (ctx, args) => {
    const targets = await ctx.db.get("goalTargets", args.goalTargetsId);
    if (targets === null) throw new Error("goalTargets row not found");

    const incoming = new Map(args.hints.map((h) => [foldForMatching(h.word), h.pronunciationHint]));

    let wordsFilled = 0;
    const words = targets.words.map((word) => {
      if (word.pronunciationHint !== undefined) return word;
      const hint = incoming.get(foldForMatching(word.word));
      if (hint === undefined) return word;
      wordsFilled++;
      return { ...word, pronunciationHint: hint };
    });

    const snapshotStamped =
      targets.targetLanguage === undefined || targets.primaryLanguage === undefined;

    if (wordsFilled > 0 || snapshotStamped) {
      await ctx.db.patch("goalTargets", targets._id, {
        words,
        targetLanguage: targets.targetLanguage ?? args.targetLanguage,
        primaryLanguage: targets.primaryLanguage ?? args.primaryLanguage,
      });
    }

    // Plan words take their hint from goalTargets, by word — no LLM.
    const hintByWord = new Map<string, string>();
    for (const word of words) {
      if (word.pronunciationHint !== undefined) {
        hintByWord.set(foldForMatching(word.word), word.pronunciationHint);
      }
    }

    let planWordsFilled = 0;
    const plan = await ctx.db
      .query("plans")
      .withIndex("by_goal", (q) => q.eq("goalId", targets.goalId))
      .first();
    if (plan !== null) {
      const days = plan.days.map((day) => ({
        ...day,
        words: day.words.map((word) => {
          if (word.pronunciationHint !== undefined) return word;
          const hint = hintByWord.get(foldForMatching(word.word));
          if (hint === undefined) return word;
          planWordsFilled++;
          return { ...word, pronunciationHint: hint };
        }),
      }));
      if (planWordsFilled > 0) await ctx.db.patch("plans", plan._id, { days });
    }

    return { wordsFilled, snapshotStamped, planWordsFilled };
  },
});

const HINT_BACKFILL_SYSTEM = `You write pronunciation hints for adult language learners.
For each word you are given, write how it SOUNDS, in the learner's own script, so they can read it aloud.
A strict validator checks every hint, so follow the script rule exactly.`;

/**
 * Backfills pronunciation hints for one account's active goal.
 * At most ONE LLM request (plus the standard single retry on invalid output),
 * and none at all once every word has a hint.
 *
 *   npx convex run migrations:backfillPronunciationHints '{"email":"test@speakup.dev"}'
 */
export const backfillPronunciationHints = internalAction({
  args: { email: v.string() },
  returns: v.object({
    found: v.boolean(),
    llmCalls: v.number(),
    missingBefore: v.number(),
    wordsFilled: v.number(),
    snapshotStamped: v.boolean(),
    planWordsFilled: v.number(),
    samples: v.array(v.object({ word: v.string(), pronunciationHint: v.string() })),
  }),
  handler: async (ctx, args) => {
    // Explicit annotation: same-file runQuery, see the Convex guidelines on
    // TypeScript circularity.
    const input: Infer<typeof hintBackfillInputValidator> = await ctx.runQuery(
      internal.migrations.hintBackfillInput,
      { email: args.email },
    );
    if (!input.found || input.goalTargetsId === null) {
      return {
        found: false,
        llmCalls: 0,
        missingBefore: 0,
        wordsFilled: 0,
        snapshotStamped: false,
        planWordsFilled: 0,
        samples: [],
      };
    }

    let llmCalls = 0;
    let hints: Array<{ word: string; pronunciationHint: string }> = [];

    if (input.missingWords.length > 0) {
      const record = llmRecorder(ctx);
      const target = LANGUAGE_NAMES[input.targetLanguage];
      const primary = LANGUAGE_NAMES[input.primaryLanguage];

      const validated = await llmJson({
        system: HINT_BACKFILL_SYSTEM,
        user: `Target language (the words below): ${target} (${input.targetLanguage})
Learner's primary language: ${primary} (${input.primaryLanguage})

For EVERY word below, write "pronunciationHint": ${pronunciationHintInstruction(input.targetLanguage, input.primaryLanguage)}

Return a JSON object {"hints": [...]} with exactly one entry per word, each {"word": <the word, copied exactly>, "pronunciationHint": <the hint>}.

Words:
${input.missingWords.map((w, i) => `${i + 1}. ${w}`).join("\n")}`,
        schemaName: "pronunciation_hints",
        schema: HINT_BACKFILL_JSON_SCHEMA,
        validate: (raw) =>
          validateHintBackfill(raw, {
            words: input.missingWords,
            primaryLanguage: input.primaryLanguage,
          }),
        timeoutMs: 90_000,
        maxTokens: 6_000,
        recordCall: async (entry) => {
          llmCalls++;
          await record(entry);
        },
      });
      hints = [...validated].map(([word, pronunciationHint]) => ({ word, pronunciationHint }));
    }

    const applied: { wordsFilled: number; snapshotStamped: boolean; planWordsFilled: number } =
      await ctx.runMutation(internal.migrations.applyPronunciationHints, {
        goalTargetsId: input.goalTargetsId,
        hints,
        targetLanguage: input.targetLanguage,
        primaryLanguage: input.primaryLanguage,
      });

    return {
      found: true,
      llmCalls,
      missingBefore: input.missingWords.length,
      wordsFilled: applied.wordsFilled,
      snapshotStamped: applied.snapshotStamped,
      planWordsFilled: applied.planWordsFilled,
      samples: hints.slice(0, 8),
    };
  },
});
