/**
 * Time passes (7 or 30 days). Everything after the level check requires one.
 *
 * Two ways a pass is created:
 *   - startDemoPass  public, for the static demo payment page. A paywall
 *                    bypass by design, so it is DISABLED unless the deployment
 *                    sets ALLOW_DEMO_PASSES=true. Production must not set it.
 *   - grantPass      internal, the seam for a future Razorpay / RevenueCat
 *                    webhook (an httpAction verifies the provider signature,
 *                    then calls this). Idempotent on the provider's externalId.
 *
 * Renewals stack: a new pass starts when the caller's current pass ends.
 */

import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { passSourceValidator, passTypeValidator } from "./schema";
import { invalid, notFound, requireUserId } from "./lib/authz";
import { demoPassesEnabled, passWindow, type PassType } from "./lib/passes";

const MAX_EXTERNAL_ID = 200;

type PassSource = "demo" | "razorpay" | "revenuecat";

/** Inserts a pass stacked after the user's latest one (or starting now). */
async function insertStackedPass(
  ctx: MutationCtx,
  args: { userId: Id<"users">; passId: PassType; source: PassSource; externalId?: string },
): Promise<{ id: Id<"passes">; startsAt: number; endsAt: number }> {
  const now = Date.now();
  const latest = await ctx.db
    .query("passes")
    .withIndex("by_user_and_endsAt", (q) => q.eq("userId", args.userId))
    .order("desc")
    .first();
  const window = passWindow({ passId: args.passId, now, latestEndsAt: latest?.endsAt ?? null });
  const id = await ctx.db.insert("passes", {
    userId: args.userId,
    passId: args.passId,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    source: args.source,
    ...(args.externalId !== undefined ? { externalId: args.externalId } : {}),
    createdAt: now,
  });
  return { id, ...window };
}

/**
 * The caller's most recent pass (by endsAt), or null if they never had one.
 * `isActive` is computed with SERVER time — never trust a client clock for
 * access. Note: like any Convex query, a subscribed result is not re-run just
 * because time passes, so a UI can briefly show a pass as active after it
 * expires; every gated function re-checks on its own call.
 */
export const activePass = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      passId: passTypeValidator,
      startsAt: v.number(),
      endsAt: v.number(),
      source: passSourceValidator,
      isActive: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const latest = await ctx.db
      .query("passes")
      .withIndex("by_user_and_endsAt", (q) => q.eq("userId", userId))
      .order("desc")
      .first();
    if (latest === null) return null;
    return {
      passId: latest.passId,
      startsAt: latest.startsAt,
      endsAt: latest.endsAt,
      source: latest.source,
      isActive: latest.endsAt > Date.now(),
    };
  },
});

/**
 * Demo purchase for the static payment page. Refused unless the deployment
 * env var ALLOW_DEMO_PASSES is exactly "true" (set on dev only).
 */
export const startDemoPass = mutation({
  args: { passId: passTypeValidator },
  returns: v.object({
    passId: passTypeValidator,
    startsAt: v.number(),
    endsAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    if (!demoPassesEnabled(process.env.ALLOW_DEMO_PASSES)) {
      throw new ConvexError({
        code: "demo_passes_disabled",
        message: "Demo passes are not enabled on this deployment.",
      });
    }
    const pass = await insertStackedPass(ctx, { userId, passId: args.passId, source: "demo" });
    return { passId: args.passId, startsAt: pass.startsAt, endsAt: pass.endsAt };
  },
});

/**
 * Internal seam for a payment-provider webhook. Idempotent on `externalId`:
 * a provider retrying the same event never grants a second pass. An
 * externalId already used for a DIFFERENT user is refused rather than
 * silently re-pointed.
 */
export const grantPass = internalMutation({
  args: {
    userId: v.id("users"),
    passId: passTypeValidator,
    source: passSourceValidator,
    externalId: v.optional(v.string()),
  },
  returns: v.object({
    id: v.id("passes"),
    created: v.boolean(),
    passId: passTypeValidator,
    startsAt: v.number(),
    endsAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const user = await ctx.db.get("users", args.userId);
    if (user === null) notFound("User not found");

    let externalId: string | undefined;
    if (args.externalId !== undefined) {
      externalId = args.externalId.trim();
      if (externalId.length === 0 || externalId.length > MAX_EXTERNAL_ID) {
        invalid(`externalId must be 1..${MAX_EXTERNAL_ID} characters`);
      }
      const existing = await ctx.db
        .query("passes")
        .withIndex("by_externalId", (q) => q.eq("externalId", externalId))
        .first();
      if (existing !== null) {
        if (existing.userId !== args.userId) {
          throw new ConvexError({
            code: "external_id_conflict",
            message: "This externalId already granted a pass to a different user.",
          });
        }
        return {
          id: existing._id,
          created: false,
          passId: existing.passId,
          startsAt: existing.startsAt,
          endsAt: existing.endsAt,
        };
      }
    }

    const pass = await insertStackedPass(ctx, {
      userId: args.userId,
      passId: args.passId,
      source: args.source,
      ...(externalId !== undefined ? { externalId } : {}),
    });
    return { id: pass.id, created: true, passId: args.passId, startsAt: pass.startsAt, endsAt: pass.endsAt };
  },
});
