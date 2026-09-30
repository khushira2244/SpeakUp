/**
 * Partner payout LEDGER only (docs: "No real payouts yet"). Rows are written
 * automatically by payments.ts (an "earned" entry when a room-booking
 * payment captures; held automatically if that payment is later refunded).
 * `markPaid` / `markHeld` are the only write paths beyond that, and neither
 * moves real money — they just record that a human did, or should, review
 * the entry. There is no partner-auth model yet, so these are internal only
 * (callable via `npx convex run` today; the seam for a future admin surface
 * or a real payout provider).
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { notFound } from "./lib/authz";
import { payoutStatusValidator } from "./schema";

const payoutRowValidator = v.object({
  _id: v.id("partnerPayouts"),
  partnerId: v.string(),
  paymentId: v.id("payments"),
  amount: v.number(),
  currency: v.string(),
  status: payoutStatusValidator,
  notes: v.union(v.string(), v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const listForPartner = internalQuery({
  args: { partnerId: v.string() },
  returns: v.array(payoutRowValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("partnerPayouts")
      .withIndex("by_partner", (q) => q.eq("partnerId", args.partnerId))
      .order("desc")
      .take(200);
    return rows.map((r) => ({ ...r, notes: r.notes ?? null }));
  },
});

export const listByStatus = internalQuery({
  args: { status: payoutStatusValidator },
  returns: v.array(payoutRowValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("partnerPayouts")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .take(200);
    return rows.map((r) => ({ ...r, notes: r.notes ?? null }));
  },
});

/** Ledger only: records that this entry was paid out through some OUT-OF-BAND process. Moves no money. */
export const markPaid = internalMutation({
  args: { payoutId: v.id("partnerPayouts"), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("partnerPayouts", args.payoutId);
    if (row === null) notFound("Payout not found");
    await ctx.db.patch("partnerPayouts", args.payoutId, {
      status: "paid",
      ...(args.note !== undefined ? { notes: args.note } : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Manually hold an entry for review (payments.ts already does this automatically on a refund). */
export const markHeld = internalMutation({
  args: { payoutId: v.id("partnerPayouts"), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("partnerPayouts", args.payoutId);
    if (row === null) notFound("Payout not found");
    await ctx.db.patch("partnerPayouts", args.payoutId, {
      status: "held",
      ...(args.note !== undefined ? { notes: args.note } : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});
