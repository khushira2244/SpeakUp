/**
 * Home screen: today's lesson card and the goal-relative progress counters.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import { levelValidator, planModeValidator, planWordValidator } from "./schema";
import { invalid, loadActiveGoal, requireUserId } from "./lib/authz";
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
