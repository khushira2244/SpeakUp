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
