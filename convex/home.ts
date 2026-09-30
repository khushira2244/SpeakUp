/**
 * Home screen: today's lesson card, the goal-relative progress counters, and
 * the pass-gated Words and Units tabs.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import {
  knownLanguageValidator,
  learnerGoalTypeValidator,
  levelValidator,
  planModeValidator,
  planStatusValueValidator,
  planWordValidator,
  targetLanguageValidator,
} from "./schema";
import {
  invalid,
  loadActiveGoal,
  requireActivePass,
  requireLearnerGoalType,
  requireUserId,
} from "./lib/authz";
import { generationLanguages, matchTokens, readLanguageProfile } from "./lib/languages";
import { computeDayAccess, loadPurchases } from "./purchases";

const MS_PER_DAY = 86_400_000;

/**
 * Which day of the plan the learner is on, derived from elapsed days since the
 * plan was generated and clamped to the plan's length.
 *
 * `now` is an argument rather than a `Date.now()` call because Convex queries
 * are reactive and are not rerun as the wall clock advances.
 */
export function currentDayNo(args: {
  now: number;
  generatedAt: number;
  dayCount: number;
}): number {
  if (args.dayCount <= 0) return 1;
  const elapsedDays = Math.floor((args.now - args.generatedAt) / MS_PER_DAY);
  return Math.min(args.dayCount, Math.max(1, elapsedDays + 1));
}

const todayCardValidator = v.object({
  planId: v.id("plans"),
  goalId: v.id("goals"),
  mode: planModeValidator,
  dayNo: v.number(),
  dayCount: v.number(),
  title: v.string(),
  /** Empty unless this day is unlocked or is day 1's always-visible preview. */
  words: v.array(planWordValidator),
  patterns: v.array(v.string()),
  /** The full lesson body. `null` until the day is purchased. */
  practiceSummary: v.union(v.string(), v.null()),
  access: v.object({
    dayNo: v.number(),
    unlocked: v.boolean(),
    previewAvailable: v.boolean(),
    reason: v.string(),
  }),
});

/**
 * Today's card for the caller's active plan, with its access state applied.
 *
 * Locked content is withheld server-side: a locked day never returns its
 * `practiceSummary`, so the paywall cannot be bypassed by reading the payload.
 */
export const todayCard = query({
  args: {
    /** Client wall clock in epoch milliseconds. */
    now: v.number(),
  },
  returns: v.union(todayCardValidator, v.null()),
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.now)) invalid("now must be a finite epoch-millisecond value");

    const userId = await requireUserId(ctx);
    const goal = await loadActiveGoal(ctx, userId);
    if (goal === null) return null;

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
      .first();
    if (plan === null) return null;
    if (plan.userId !== userId) invalid("Plan ownership mismatch");

    const dayNo = currentDayNo({
      now: args.now,
      generatedAt: plan.generatedAt,
      dayCount: plan.days.length,
    });
    const day = plan.days[dayNo - 1];
    if (day === undefined) return null;

    const purchases = await loadPurchases(ctx, userId, plan._id);
    const access = computeDayAccess({ dayNo, purchases });

    // Day 1 preview shows title + words + patterns but never the lesson body.
    const showPreview = access.unlocked || access.previewAvailable;

    return {
      planId: plan._id,
      goalId: goal._id,
      mode: plan.mode,
      dayNo,
      dayCount: plan.days.length,
      title: day.title,
      words: showPreview ? day.words : [],
      patterns: showPreview ? day.patterns : [],
      practiceSummary: access.unlocked ? day.practiceSummary : null,
      access,
    };
  },
});

const progressCountsValidator = v.object({
  goalId: v.id("goals"),
  levelCheckId: v.id("levelChecks"),
  level: levelValidator,
  canUse: v.number(),
  practising: v.number(),
  notYet: v.number(),
  knownCount: v.number(),
  totalCount: v.number(),
});

/**
 * Goal-relative progress from the most recent level result for the caller's
 * active goal. `null` before the first level check has been scored.
 */
export const progressCounts = query({
  args: {},
  returns: v.union(progressCountsValidator, v.null()),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const goal = await loadActiveGoal(ctx, userId);
    if (goal === null) return null;

    const result = await ctx.db
      .query("levelResults")
      .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
      .order("desc")
      .first();
    if (result === null) return null;
    if (result.userId !== userId) invalid("Level result ownership mismatch");

    return {
      goalId: goal._id,
      levelCheckId: result.levelCheckId,
      level: result.level,
      canUse: result.canUse.length,
      practising: result.practising.length,
      notYet: result.notYet.length,
      knownCount: result.knownCount,
      totalCount: result.totalCount,
    };
  },
});

// ---------------------------------------------------------------------------
// Words tab (GATED)
// ---------------------------------------------------------------------------

export type WordStatus = "canUse" | "practising" | "notYet";

/**
 * Pure: attaches a status to each goal word from a level result, matching with
 * the same German-aware normalisation scoring uses. Stored order is kept. With
 * no level result, every word is "notYet". If a word somehow appears in more
 * than one bucket, the strongest wins (canUse > practising > notYet).
 */
export function wordStatuses(
  words: ReadonlyArray<{ word: string; meaning: string; pronunciationHint?: string | undefined }>,
  result: { canUse: readonly string[]; practising: readonly string[] } | null,
): Array<{ word: string; meaning: string; pronunciationHint: string | null; status: WordStatus }> {
  const key = (w: string) => matchTokens(w).join(" ");
  const canUse = new Set((result?.canUse ?? []).map(key));
  const practising = new Set((result?.practising ?? []).map(key));
  return words.map((w) => {
    const k = key(w.word);
    const status: WordStatus = canUse.has(k) ? "canUse" : practising.has(k) ? "practising" : "notYet";
    return {
      word: w.word,
      meaning: w.meaning,
      pronunciationHint: w.pronunciationHint ?? null,
      status,
    };
  });
}

const wordStatusValidator = v.union(
  v.literal("canUse"),
  v.literal("practising"),
  v.literal("notYet"),
);

/**
 * GATED. The active goal's words with their status from the latest level
 * result. `null` only when there is no active goal or its targets are not
 * generated yet. Throws ConvexError { code: "no_active_pass" } without a pass.
 */
export const words = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      targetLanguage: targetLanguageValidator,
      primaryLanguage: knownLanguageValidator,
      level: v.union(levelValidator, v.null()),
      words: v.array(
        v.object({
          word: v.string(),
          meaning: v.string(),
          pronunciationHint: v.union(v.string(), v.null()),
          status: wordStatusValidator,
        }),
      ),
      counts: v.object({
        canUse: v.number(),
        practising: v.number(),
        notYet: v.number(),
        total: v.number(),
      }),
    }),
  ),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    await requireActivePass(ctx, userId);

    const goal = await loadActiveGoal(ctx, userId);
    if (goal === null) return null;
    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
      .first();
    if (targets === null) return null;

    const user = await ctx.db.get("users", userId);
    const languages = generationLanguages(targets, user === null ? null : readLanguageProfile(user));

    const latest = await ctx.db
      .query("levelResults")
      .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
      .order("desc")
      .first();
    const result = latest !== null && latest.userId === userId ? latest : null;

    const words = wordStatuses(targets.words, result);
    const counts = { canUse: 0, practising: 0, notYet: 0, total: words.length };
    for (const w of words) counts[w.status]++;

    return {
      targetLanguage: languages.targetLanguage,
      primaryLanguage: languages.primaryLanguage,
      level: result?.level ?? null,
      words,
      counts,
    };
  },
});

// ---------------------------------------------------------------------------
// Units tab (GATED)
// ---------------------------------------------------------------------------

/**
 * GATED. The goal, its grammar concepts, and the whole plan (every day's full
 * content — it is all behind the pass). `plan` is null until generated.
 * `currentDay` uses SERVER time (see requireActivePass for why this query
 * reads the clock); it is 1-based and clamped to the plan's length.
 */
export const units = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      goal: v.object({ goalId: v.id("goals"), goalType: learnerGoalTypeValidator, goalText: v.string() }),
      concepts: v.array(
        v.object({ pattern: v.string(), example: v.string(), meaning: v.string() }),
      ),
      /**
       * `null` while `plans.generatePlan` (or the scheduled first run) hasn't
       * produced a plan yet. `planStatus` is only meaningful then: "generating"
       * mid-flight, "failed" if the last attempt was rejected (the client can
       * call `plans.generatePlan` again with this goal's ID to retry), or
       * `null` for an old row from before generation tracked status.
       */
      planStatus: v.union(planStatusValueValidator, v.null()),
      plan: v.union(
        v.null(),
        v.object({
          mode: planModeValidator,
          currentDay: v.number(),
          days: v.array(
            v.object({
              dayNo: v.number(),
              title: v.string(),
              patterns: v.array(v.string()),
              words: v.array(
                v.object({
                  word: v.string(),
                  meaning: v.string(),
                  pronunciationHint: v.union(v.string(), v.null()),
                }),
              ),
              practiceSummary: v.string(),
            }),
          ),
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    await requireActivePass(ctx, userId);

    const goal = await loadActiveGoal(ctx, userId);
    if (goal === null) return null;
    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
      .first();
    if (targets === null) return null;

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
      .first();
    if (plan !== null && plan.userId !== userId) invalid("Plan ownership mismatch");

    const status =
      plan === null
        ? await ctx.db
            .query("planStatus")
            .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
            .first()
        : null;

    return {
      goal: { goalId: goal._id, goalType: requireLearnerGoalType(goal), goalText: goal.goalText },
      concepts: targets.patterns.map((p) => ({
        pattern: p.pattern,
        example: p.example,
        meaning: p.meaning,
      })),
      planStatus: status?.status ?? null,
      plan:
        plan === null
          ? null
          : {
              mode: plan.mode,
              currentDay: currentDayNo({
                now: Date.now(),
                generatedAt: plan.generatedAt,
                dayCount: plan.days.length,
              }),
              days: plan.days.map((day) => ({
                dayNo: day.dayNo,
                title: day.title,
                patterns: day.patterns,
                words: day.words.map((w) => ({
                  word: w.word,
                  meaning: w.meaning,
                  pronunciationHint: w.pronunciationHint ?? null,
                })),
                practiceSummary: day.practiceSummary,
              })),
            },
    };
  },
});
