/**
 * The learner's saved words (from their goal vocabulary or a dictionary
 * lookup). Every function is GATED behind an active pass and scoped to the
 * authenticated caller.
 */

import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { savedWordSourceValidator } from "./schema";
import {
  forbidden,
  invalid,
  loadLearnerLanguages,
  requireActivePass,
  requireUser,
  requireUserId,
} from "./lib/authz";
import { matchTokens } from "./lib/languages";

export const SAVED_WORD_LIMITS = { word: 60, meaning: 200, hint: 120 } as const;
export const SAVED_WORDS_CAP = 50;
const LIST_LIMIT = 100;

export type CleanSavedWord = {
  word: string;
  normalized: string;
  meaning: string;
  pronunciationHint?: string;
};

/**
 * Pure: trims and length-checks a save request. The normalized key uses the
 * same matching fold as scoring, so "Straße" and "strasse" are one word.
 */
export function cleanSavedWordInput(input: {
  word: string;
  meaning: string;
  pronunciationHint?: string | undefined;
}): { ok: true; value: CleanSavedWord } | { ok: false; reason: string } {
  const word = input.word.trim().replace(/\s+/g, " ");
  const meaning = input.meaning.trim();
  const hint = input.pronunciationHint?.trim() ?? "";

  if (word.length === 0) return { ok: false, reason: "word must not be empty" };
  if (word.length > SAVED_WORD_LIMITS.word) {
    return { ok: false, reason: `word must be at most ${SAVED_WORD_LIMITS.word} characters` };
  }
  if (meaning.length === 0) return { ok: false, reason: "meaning must not be empty" };
  if (meaning.length > SAVED_WORD_LIMITS.meaning) {
    return { ok: false, reason: `meaning must be at most ${SAVED_WORD_LIMITS.meaning} characters` };
  }
  if (hint.length > SAVED_WORD_LIMITS.hint) {
    return { ok: false, reason: `pronunciationHint must be at most ${SAVED_WORD_LIMITS.hint} characters` };
  }
  const normalized = matchTokens(word).join(" ");
  if (normalized.length === 0) return { ok: false, reason: "word must contain letters" };

  return {
    ok: true,
    value: { word, normalized, meaning, ...(hint.length > 0 ? { pronunciationHint: hint } : {}) },
  };
}

/**
 * Pure: what `save` should do. A duplicate always returns the existing row —
 * even at the cap — so re-saving a word never fails and never adds a row.
 */
export function saveDecision<T>(args: {
  duplicateId: T | null;
  count: number;
}): { kind: "existing"; id: T } | { kind: "limit" } | { kind: "insert" } {
  if (args.duplicateId !== null) return { kind: "existing", id: args.duplicateId };
  if (args.count >= SAVED_WORDS_CAP) return { kind: "limit" };
  return { kind: "insert" };
}

/** GATED. The caller's saved words, newest first (at most 100). */
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("savedWords"),
      word: v.string(),
      meaning: v.string(),
      pronunciationHint: v.union(v.string(), v.null()),
      source: savedWordSourceValidator,
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    await requireActivePass(ctx, userId);
    const rows = await ctx.db
      .query("savedWords")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(LIST_LIMIT);
    return rows.map((row) => ({
      _id: row._id,
      word: row.word,
      meaning: row.meaning,
      pronunciationHint: row.pronunciationHint ?? null,
      source: row.source,
      createdAt: row.createdAt,
    }));
  },
});

/**
 * GATED. Saves a word in the caller's current target language. Idempotent:
 * the same normalized word returns the existing id. Over the cap of 50 it
 * throws ConvexError { code: "limit" }.
 */
export const save = mutation({
  args: {
    word: v.string(),
    meaning: v.string(),
    pronunciationHint: v.optional(v.string()),
    source: savedWordSourceValidator,
  },
  returns: v.id("savedWords"),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireActivePass(ctx, user._id);

    const languages = await loadLearnerLanguages(ctx, user);
    if (languages === null) invalid("Choose your languages first: call users.updateProfile.");

    const cleaned = cleanSavedWordInput(args);
    if (!cleaned.ok) invalid(cleaned.reason);
    const value = cleaned.value;

    const sameKey = await ctx.db
      .query("savedWords")
      .withIndex("by_user_and_normalized", (q) =>
        q.eq("userId", user._id).eq("normalized", value.normalized),
      )
      .take(10);
    const duplicate = sameKey.find((row) => row.targetLanguage === languages.targetLanguage);

    // Bounded count: only need to know whether the cap is reached.
    const count = (
      await ctx.db
        .query("savedWords")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .take(SAVED_WORDS_CAP + 1)
    ).length;

    const decision = saveDecision<Id<"savedWords">>({
      duplicateId: duplicate?._id ?? null,
      count,
    });
    if (decision.kind === "existing") return decision.id;
    if (decision.kind === "limit") {
      throw new ConvexError({
        code: "limit",
        message: `You can save up to ${SAVED_WORDS_CAP} words.`,
      });
    }

    return await ctx.db.insert("savedWords", {
      userId: user._id,
      targetLanguage: languages.targetLanguage,
      word: value.word,
      normalized: value.normalized,
      meaning: value.meaning,
      ...(value.pronunciationHint !== undefined ? { pronunciationHint: value.pronunciationHint } : {}),
      source: args.source,
      createdAt: Date.now(),
    });
  },
});

/**
 * GATED. Deletes one of the caller's saved words. Idempotent: an id that no
 * longer exists returns null; another user's row is refused.
 */
export const remove = mutation({
  args: { id: v.id("savedWords") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireActivePass(ctx, userId);
    const row = await ctx.db.get("savedWords", args.id);
    if (row === null) return null;
    if (row.userId !== userId) forbidden("This saved word belongs to another user");
    await ctx.db.delete("savedWords", args.id);
    return null;
  },
});
