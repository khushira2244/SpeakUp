/**
 * Authentication + per-document ownership helpers.
 *
 * HARD RULE enforced through this module: identity is ALWAYS derived
 * server-side from Convex Auth. No public function accepts a `userId`
 * argument, and every lookup by `goalId` / `levelCheckId` / `planId` loads the
 * parent document and checks its `userId` against the caller before returning
 * or mutating anything.
 */

import { ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Auth } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { passCoversNow } from "./passes";
import {
  generationLanguages,
  readLanguageProfile,
  type KnownLanguage,
  type TargetLanguage,
} from "./languages";

export type DbCtx = QueryCtx | MutationCtx;

export function unauthorized(message = "Not signed in"): never {
  throw new ConvexError({ code: "UNAUTHENTICATED", message });
}

export function forbidden(message = "You do not have access to this record"): never {
  throw new ConvexError({ code: "FORBIDDEN", message });
}

export function notFound(message = "Record not found"): never {
  throw new ConvexError({ code: "NOT_FOUND", message });
}

export function invalid(message: string): never {
  throw new ConvexError({ code: "INVALID", message });
}

/**
 * The authenticated user's id, or `null`. Works in queries, mutations and
 * actions (all three expose `ctx.auth`).
 */
export async function getUserId(ctx: { auth: Auth }): Promise<Id<"users"> | null> {
  return await getAuthUserId(ctx);
}

/** The authenticated user's id. Throws when the caller is not signed in. */
export async function requireUserId(ctx: { auth: Auth }): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) unauthorized();
  return userId;
}

/** The authenticated user's document. Throws when not signed in. */
export async function requireUser(ctx: DbCtx): Promise<Doc<"users">> {
  const userId = await requireUserId(ctx);
  const user = await ctx.db.get("users", userId);
  if (user === null) unauthorized("Signed-in user record no longer exists");
  return user;
}

/**
 * Loads a goal and asserts `userId` owns it.
 * Never trust a client-supplied goalId without this.
 */
export async function requireOwnedGoal(
  ctx: DbCtx,
  goalId: Id<"goals">,
  userId: Id<"users">,
): Promise<Doc<"goals">> {
  const goal = await ctx.db.get("goals", goalId);
  if (goal === null) notFound("Goal not found");
  if (goal.userId !== userId) forbidden("This goal belongs to another user");
  return goal;
}

/** Loads a level check and asserts `userId` owns it. */
export async function requireOwnedLevelCheck(
  ctx: DbCtx,
  levelCheckId: Id<"levelChecks">,
  userId: Id<"users">,
): Promise<Doc<"levelChecks">> {
  const levelCheck = await ctx.db.get("levelChecks", levelCheckId);
  if (levelCheck === null) notFound("Level check not found");
  if (levelCheck.userId !== userId) {
    forbidden("This level check belongs to another user");
  }
  return levelCheck;
}

/** Loads a plan and asserts `userId` owns it. */
export async function requireOwnedPlan(
  ctx: DbCtx,
  planId: Id<"plans">,
  userId: Id<"users">,
): Promise<Doc<"plans">> {
  const plan = await ctx.db.get("plans", planId);
  if (plan === null) notFound("Plan not found");
  if (plan.userId !== userId) forbidden("This plan belongs to another user");
  return plan;
}

// ---------------------------------------------------------------------------
// Access passes
// ---------------------------------------------------------------------------

/**
 * Throws ConvexError({ code: "no_active_pass" }) unless `candidate` covers
 * `now`. Split out from requireActivePass so the rule is testable offline.
 */
export function assertPassCovers(
  candidate: { startsAt: number; endsAt: number } | null,
  now: number,
): void {
  if (!passCoversNow(candidate, now)) {
    throw new ConvexError({
      code: "no_active_pass",
      message: "An active pass is required for this.",
    });
  }
}

/**
 * The paywall. Every post-level-check function calls this.
 *
 * Uses SERVER time on purpose: accepting a client-supplied `now` would let a
 * learner bypass expiry by sending an old timestamp. (The Convex guideline to
 * avoid the wall clock in queries is about result staleness; for an access
 * gate, correctness wins — see README "Access passes".)
 *
 * Passes stack contiguously, so the earliest-ending pass that has not ended
 * yet is the one that covers now — or nothing does.
 */
export async function requireActivePass(
  ctx: DbCtx,
  userId: Id<"users">,
): Promise<Doc<"passes">> {
  const now = Date.now();
  const candidate = await ctx.db
    .query("passes")
    .withIndex("by_user_and_endsAt", (q) => q.eq("userId", userId).gt("endsAt", now))
    .first();
  assertPassCovers(candidate, now);
  return candidate as Doc<"passes">;
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/**
 * The caller's working languages: the active goal's generation snapshot when
 * targets exist (the words were generated in exactly those languages), else
 * the live profile. `null` when neither exists.
 */
/**
 * `goalOverride`, when given, is used INSTEAD of the caller's active goal —
 * the seam for a partner's speaking test, which streams/scores in its own
 * `goalType: "partner_test"` goal's language while the caller's real active
 * goal (whatever they are personally learning) stays untouched.
 */
export async function loadLearnerLanguages(
  ctx: DbCtx,
  user: Doc<"users">,
  goalOverride?: Doc<"goals">,
): Promise<{
  targetLanguage: TargetLanguage;
  primaryLanguage: KnownLanguage;
  source: "goal" | "profile";
} | null> {
  const profile = readLanguageProfile(user);
  const goal = goalOverride ?? (await loadActiveGoal(ctx, user._id));
  if (goal !== null) {
    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
      .first();
    if (targets !== null) {
      const generated = generationLanguages(targets, profile);
      return {
        targetLanguage: generated.targetLanguage,
        primaryLanguage: generated.primaryLanguage,
        source: "goal",
      };
    }
  }
  if (profile === null) return null;
  return {
    targetLanguage: profile.targetLanguage,
    primaryLanguage: profile.primaryLanguage,
    source: "profile",
  };
}

/** The caller's currently active goal, or `null`. */
export async function loadActiveGoal(
  ctx: DbCtx,
  userId: Id<"users">,
): Promise<Doc<"goals"> | null> {
  return await ctx.db
    .query("goals")
    .withIndex("by_user_and_active", (q) => q.eq("userId", userId).eq("active", true))
    .order("desc")
    .first();
}

/**
 * Narrows a goal's `goalType` for learner-facing outputs (goals.activeGoal,
 * home.units), which promise `learnerGoalTypeValidator` — never
 * "partner_test". A `goals.setGoal` partner_test goal is always inserted
 * with `active: false` (convex/partners.ts), so `loadActiveGoal` should never
 * actually return one; this is the defensive bridge from the wider stored
 * type, and throws (a genuine invariant violation, not client input) if that
 * ever stops being true.
 */
export function requireLearnerGoalType(goal: Doc<"goals">): Exclude<Doc<"goals">["goalType"], "partner_test"> {
  if (goal.goalType === "partner_test") {
    throw new Error(`Goal ${goal._id} is a partner_test goal and must never be a learner's active goal`);
  }
  return goal.goalType;
}
