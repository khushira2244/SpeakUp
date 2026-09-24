/**
 * Demo purchases. No real payment processor is involved: every row is written
 * with `isDemo: true` and `status: "paid"`.
 *
 * Purchases are also the ONLY gate that permits plan regeneration. Nothing in
 * this backend regenerates a plan automatically.
 */

import { v } from "convex/values";
import { action, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { planModeValidator, purchaseTypeValidator } from "./schema";
import {
  forbidden,
  invalid,
  requireOwnedGoal,
  requireOwnedPlan,
  requireUserId,
  type DbCtx,
} from "./lib/authz";
import { generatePlanInternal } from "./plans";

export type PurchaseType = "day" | "week" | "quick_prep" | "regen";

/** Demo price list, in USD. Server-owned: never taken from the client. */
export const PRICES = {
  day: 0.99,
  week: 4.99,
  quick_prep: 0.99,
  /** Regenerating a single day. */
  regen_day: 0.49,
  /** Regenerating the whole week. */
  regen_week: 1.99,
} as const;

export function priceFor(type: PurchaseType, dayNo: number | undefined): number {
  switch (type) {
    case "day":
      return PRICES.day;
    case "week":
      return PRICES.week;
    case "quick_prep":
      return PRICES.quick_prep;
    case "regen":
      return dayNo === undefined ? PRICES.regen_week : PRICES.regen_day;
  }
}

// ---------------------------------------------------------------------------
// Access rules (pure, shared with home.ts)
// ---------------------------------------------------------------------------

export type DayAccess = {
  dayNo: number;
  /** Full lesson content (including practiceSummary) is available. */
  unlocked: boolean;
  /** Title / words / patterns are visible, but the lesson body is not. */
  previewAvailable: boolean;
  reason: string;
};

/**
 * Deterministic unlock rules:
 *   - a "week" purchase unlocks every day
 *   - a "day" purchase unlocks only that dayNo
 *   - a "quick_prep" purchase unlocks day 1
 *   - day 1's preview is always visible, purchased or not
 */
export function computeDayAccess(args: {
  dayNo: number;
  purchases: ReadonlyArray<{ type: PurchaseType; dayNo?: number | undefined }>;
}): DayAccess {
  const previewAvailable = args.dayNo === 1;

  for (const purchase of args.purchases) {
    if (purchase.type === "week") {
      return {
        dayNo: args.dayNo,
        unlocked: true,
        previewAvailable: true,
        reason: "week purchase unlocks every day",
      };
    }
    if (purchase.type === "day" && purchase.dayNo === args.dayNo) {
      return {
        dayNo: args.dayNo,
        unlocked: true,
        previewAvailable: true,
        reason: `day purchase for day ${args.dayNo}`,
      };
    }
    if (purchase.type === "quick_prep" && args.dayNo === 1) {
      return {
        dayNo: args.dayNo,
        unlocked: true,
        previewAvailable: true,
        reason: "quick prep purchase unlocks day 1",
      };
    }
  }

  return {
    dayNo: args.dayNo,
    unlocked: false,
    previewAvailable,
    reason: previewAvailable
      ? "day 1 preview is always visible; buy to unlock the full lesson"
      : "locked: no purchase covers this day",
  };
}

// ---------------------------------------------------------------------------
// purchase
// ---------------------------------------------------------------------------

/** Records a paid demo purchase against one of the caller's own plans. */
export const purchase = mutation({
  args: {
    planId: v.id("plans"),
    type: purchaseTypeValidator,
    dayNo: v.optional(v.number()),
  },
  returns: v.object({
    purchaseId: v.id("purchases"),
    amountUsd: v.number(),
    alreadyOwned: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const plan = await requireOwnedPlan(ctx, args.planId, userId);

    if (args.dayNo !== undefined) {
      if (!Number.isInteger(args.dayNo) || args.dayNo < 1 || args.dayNo > plan.days.length) {
        invalid(`dayNo must be an integer in 1..${plan.days.length}`);
      }
    }

    switch (args.type) {
      case "day":
        if (args.dayNo === undefined) invalid('a "day" purchase requires dayNo');
        break;
      case "week":
        if (args.dayNo !== undefined) invalid('a "week" purchase must not set dayNo');
        if (plan.mode !== "week") invalid('this plan is quick_prep; buy "quick_prep"');
        break;
      case "quick_prep":
        if (args.dayNo !== undefined) invalid('a "quick_prep" purchase must not set dayNo');
        if (plan.mode !== "quick_prep") invalid('this plan is a week plan; buy "week"');
        break;
      case "regen":
        // dayNo is optional and only selects the price tier.
        break;
    }

    const amountUsd = priceFor(args.type, args.dayNo);

    // Re-buying access the caller already has is a no-op rather than a second
    // charge. "regen" is deliberately excluded: each one is a fresh credit.
    if (args.type !== "regen") {
      const owned = await ctx.db
        .query("purchases")
        .withIndex("by_user_and_plan_and_type", (q) =>
          q.eq("userId", userId).eq("planId", args.planId).eq("type", args.type),
        )
        .take(50);
      const duplicate = owned.find((p) => p.dayNo === args.dayNo);
      if (duplicate !== undefined) {
        return {
          purchaseId: duplicate._id,
          amountUsd: duplicate.amountUsd,
          alreadyOwned: true,
        };
      }
    }

    const purchaseId = await ctx.db.insert("purchases", {
      userId,
      planId: args.planId,
      type: args.type,
      dayNo: args.dayNo,
      amountUsd,
      status: "paid",
      isDemo: true,
      createdAt: Date.now(),
    });

    return { purchaseId, amountUsd, alreadyOwned: false };
  },
});

// ---------------------------------------------------------------------------
// canAccess
// ---------------------------------------------------------------------------

/** Every purchase the caller holds against one of their own plans. */
export async function loadPurchases(
  ctx: DbCtx,
  userId: Id<"users">,
  planId: Id<"plans">,
): Promise<Array<{ type: PurchaseType; dayNo?: number | undefined }>> {
  const rows = await ctx.db
    .query("purchases")
    .withIndex("by_user_and_plan", (q) => q.eq("userId", userId).eq("planId", planId))
    .take(200);
  return rows.map((row) => ({ type: row.type, dayNo: row.dayNo }));
}

const dayAccessValidator = v.object({
  dayNo: v.number(),
  unlocked: v.boolean(),
  previewAvailable: v.boolean(),
  reason: v.string(),
});

/** Whether the caller may see the full lesson body for one day of their plan. */
export const canAccess = query({
  args: { planId: v.id("plans"), dayNo: v.number() },
  returns: dayAccessValidator,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const plan = await requireOwnedPlan(ctx, args.planId, userId);
    if (!Number.isInteger(args.dayNo) || args.dayNo < 1 || args.dayNo > plan.days.length) {
      invalid(`dayNo must be an integer in 1..${plan.days.length}`);
    }
    const purchases = await loadPurchases(ctx, userId, args.planId);
    return computeDayAccess({ dayNo: args.dayNo, purchases });
  },
});

// ---------------------------------------------------------------------------
// regenPlan
// ---------------------------------------------------------------------------

const regenGateValidator = v.object({
  planId: v.id("plans"),
  mode: planModeValidator,
  hasUnspentRegenPurchase: v.boolean(),
});

/**
 * Internal: checks that an unspent, paid "regen" purchase exists for this plan.
 *
 * "Unspent" is derived from timestamps rather than a mutable flag: a regen
 * purchase counts only while it is NEWER than the plan's `generatedAt`. Once a
 * regeneration runs, `generatedAt` moves past it, so the same purchase cannot
 * fund a second regeneration.
 */
export const regenGate = internalQuery({
  args: { goalId: v.id("goals"), userId: v.id("users") },
  returns: v.union(regenGateValidator, v.null()),
  handler: async (ctx, args) => {
    await requireOwnedGoal(ctx, args.goalId, args.userId);
    const plan = await ctx.db
      .query("plans")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();
    if (plan === null) return null;
    if (plan.userId !== args.userId) forbidden("This plan belongs to another user");

    const regens = await ctx.db
      .query("purchases")
      .withIndex("by_user_and_plan_and_type", (q) =>
        q.eq("userId", args.userId).eq("planId", plan._id).eq("type", "regen"),
      )
      .take(100);

    return {
      planId: plan._id,
      mode: plan.mode,
      hasUnspentRegenPurchase: regens.some(
        (row) => row.status === "paid" && row.createdAt > plan.generatedAt,
      ),
    };
  },
});

/**
 * The ONLY path that replaces an existing plan. Requires a paid, unspent
 * "regen" purchase for that plan.
 */
export const regenPlan = action({
  args: { goalId: v.id("goals") },
  returns: v.object({
    planId: v.id("plans"),
    mode: planModeValidator,
    regenerated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    const gate = await ctx.runQuery(internal.purchases.regenGate, {
      goalId: args.goalId,
      userId,
    });
    if (gate === null) {
      invalid("There is no plan for this goal yet. Use plans.generatePlan first.");
    }
    if (!gate.hasUnspentRegenPurchase) {
      forbidden(
        'Regenerating a plan requires a paid "regen" purchase made after the current plan was generated. Call purchases.purchase with type "regen" first.',
      );
    }

    const result = await generatePlanInternal(ctx, {
      goalId: args.goalId,
      userId,
      replaceExisting: true,
    });

    return { planId: result.planId, mode: result.mode, regenerated: true };
  },
});

/** Internal helper used by the end-to-end test harness. */
export const purchaseCountForPlan = internalQuery({
  args: { planId: v.id("plans"), userId: v.id("users") },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireOwnedPlan(ctx, args.planId, args.userId);
    const rows = await ctx.db
      .query("purchases")
      .withIndex("by_user_and_plan", (q) =>
        q.eq("userId", args.userId).eq("planId", args.planId),
      )
      .take(200);
    return rows.length;
  },
});
