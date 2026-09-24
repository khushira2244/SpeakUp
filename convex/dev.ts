/**
 * Development-only maintenance functions.
 *
 * Everything here is `internalMutation` / `internalQuery`, so none of it is
 * reachable from a client. The seed script invokes `devReset` through the
 * Convex CLI (`convex run`), which authenticates with the deploy key.
 *
 * `devReset` is destructive and exists solely to support the seed script's
 * `--fresh` flag. It wipes one account's LEARNING STATE; it never deletes the
 * account itself, so sign-in stays stable across resets.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const MAX_ROWS = 500;

const resetCountsValidator = v.object({
  goals: v.number(),
  goalTargets: v.number(),
  levelChecks: v.number(),
  attempts: v.number(),
  levelResults: v.number(),
  plans: v.number(),
  purchases: v.number(),
});

/**
 * Deletes every piece of learning state belonging to `email`.
 * Returns row counts so the caller can report what was cleared.
 */
export const devReset = internalMutation({
  args: { email: v.string() },
  returns: v.object({
    found: v.boolean(),
    userId: v.union(v.id("users"), v.null()),
    deleted: resetCountsValidator,
  }),
  handler: async (ctx, args) => {
    const deleted = {
      goals: 0,
      goalTargets: 0,
      levelChecks: 0,
      attempts: 0,
      levelResults: 0,
      plans: 0,
      purchases: 0,
    };

    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email))
      .first();
    if (user === null) {
      return { found: false, userId: null, deleted };
    }
    const userId: Id<"users"> = user._id;

    // Purchases -> plans -> levelResults -> attempts -> levelChecks ->
    // goalTargets -> goals. Children before parents.
    const purchases = await ctx.db
      .query("purchases")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_ROWS);
    for (const row of purchases) {
      await ctx.db.delete("purchases", row._id);
      deleted.purchases++;
    }

    const plans = await ctx.db
      .query("plans")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_ROWS);
    for (const row of plans) {
      await ctx.db.delete("plans", row._id);
      deleted.plans++;
    }

    const levelResults = await ctx.db
      .query("levelResults")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_ROWS);
    for (const row of levelResults) {
      await ctx.db.delete("levelResults", row._id);
      deleted.levelResults++;
    }

    const levelChecks = await ctx.db
      .query("levelChecks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_ROWS);
    for (const check of levelChecks) {
      const attempts = await ctx.db
        .query("attempts")
        .withIndex("by_level_check", (q) => q.eq("levelCheckId", check._id))
        .take(MAX_ROWS);
      for (const attempt of attempts) {
        await ctx.db.delete("attempts", attempt._id);
        deleted.attempts++;
      }
      await ctx.db.delete("levelChecks", check._id);
      deleted.levelChecks++;
    }

    const goals = await ctx.db
      .query("goals")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_ROWS);
    for (const goal of goals) {
      const targets = await ctx.db
        .query("goalTargets")
        .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
        .take(MAX_ROWS);
      for (const target of targets) {
        await ctx.db.delete("goalTargets", target._id);
        deleted.goalTargets++;
      }
      await ctx.db.delete("goals", goal._id);
      deleted.goals++;
    }

    return { found: true, userId, deleted };
  },
});
