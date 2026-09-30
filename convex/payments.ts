/**
 * Payments (Razorpay, test mode). One generic `payments` table serves both
 * the learner time pass (auto-capture) and room bookings (manual capture) —
 * see the payments-build report for the Razorpay API details this was built
 * against.
 *
 * Trust boundary: a client-supplied amount is never trusted for either
 * purpose. A PASS's amount is looked up server-side from env. A ROOM
 * BOOKING's amount comes from rooms.bookingPricingInfo (the booking's own
 * mode/minutes) plus the fixed price table in lib/rooms.ts — always INR,
 * regardless of RAZORPAY_ORDER_CURRENCY. See roomBookingOrderAmount below.
 *
 * The actual money-moving calls (create order, capture, refund) and the
 * webhook's signature check live in ./lib/razorpay — this file is Convex
 * plumbing: validators, ownership, idempotent state transitions, and the
 * grantPass / partnerPayouts side effects.
 */

import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { paymentPurposeValidator, paymentStatusValidator, payoutStatusValidator } from "./schema";
import { forbidden, invalid, notFound, requireUserId } from "./lib/authz";
import { partnerEarningInrPaise, roomChargeInrPaise, type RoomMinutes, type RoomMode } from "./lib/rooms";
import {
  RazorpayConfigError,
  capturePayment as razorpayCapturePayment,
  createOrder as razorpayCreateOrder,
  readOrderCurrency,
  readRazorpayConfig,
  refundPayment as razorpayRefundPayment,
  verifyCheckoutSignature,
  type RazorpayConfig,
} from "./lib/razorpay";

const MAX_NOTE_ENTRIES = 15;
const MAX_NOTE_LENGTH = 256;

/** Razorpay caps `receipt` at 56 characters — a room_booking's refId is a full Convex id, so the purpose is abbreviated to leave room for it. */
function buildReceipt(purpose: "pass" | "room_booking", refId: string): string {
  const prefix = purpose === "pass" ? "pass" : "room";
  return `${prefix}_${refId}_${Date.now()}`.slice(0, 56);
}

function validateNotes(notes: Record<string, string> | undefined): Record<string, string> | undefined {
  if (notes === undefined) return undefined;
  const entries = Object.entries(notes);
  if (entries.length > MAX_NOTE_ENTRIES) invalid(`notes: at most ${MAX_NOTE_ENTRIES} entries`);
  for (const [key, value] of entries) {
    if (value.length > MAX_NOTE_LENGTH) invalid(`notes.${key}: at most ${MAX_NOTE_LENGTH} characters`);
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Pricing: a PASS's amount is always server-owned, never client-supplied.
// ---------------------------------------------------------------------------

/** Amount in the smallest subunit of the order currency (paise for INR, cents for USD, ...). No hardcoded default — see the report on currency/USD. */
function passPriceMinorUnits(passId: string): number {
  if (passId !== "week" && passId !== "month") invalid(`Unknown pass id "${passId}"`);
  const envKey = passId === "week" ? "RAZORPAY_PRICE_WEEK" : "RAZORPAY_PRICE_MONTH";
  const raw = process.env[envKey];
  if (!raw || raw.trim().length === 0) {
    throw new RazorpayConfigError(
      `${envKey} is not set on this Convex deployment (amount in the smallest subunit of the order currency). Set it with: npx convex env set ${envKey} <amount>`,
    );
  }
  const amount = Number(raw);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new RazorpayConfigError(`${envKey} must be a positive integer (smallest currency subunit), got "${raw}"`);
  }
  return amount;
}

/** A room-booking amount has no trusted server-side price source yet (see file header) — only bounded so a typo/bug can't create a wildly wrong order. */
const MAX_AMOUNT_MINOR_UNITS = 50_000_00; // a sanity ceiling, not a real price rule.

function requireValidAmount(amount: number | undefined): number {
  if (amount === undefined || !Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    invalid("amount must be a positive integer (the smallest currency subunit)");
  }
  if (amount > MAX_AMOUNT_MINOR_UNITS) invalid(`amount exceeds the sanity ceiling of ${MAX_AMOUNT_MINOR_UNITS}`);
  return amount;
}

// ---------------------------------------------------------------------------
// Order creation
// ---------------------------------------------------------------------------

export const recordOrder = internalMutation({
  args: {
    userId: v.id("users"),
    purpose: paymentPurposeValidator,
    refId: v.string(),
    amount: v.number(),
    currency: v.string(),
    razorpayOrderId: v.string(),
    notes: v.optional(v.record(v.string(), v.string())),
  },
  returns: v.id("payments"),
  handler: async (ctx, args) => {
    requireValidAmount(args.amount); // defense in depth — createOrder already validated this before calling Razorpay.
    const now = Date.now();
    return await ctx.db.insert("payments", {
      userId: args.userId,
      purpose: args.purpose,
      refId: args.refId,
      amount: args.amount,
      currency: args.currency,
      razorpayOrderId: args.razorpayOrderId,
      status: "created",
      ...(args.notes !== undefined ? { notes: args.notes } : {}),
      createdAt: now,
      updatedAt: now,
    });
  },
});

const createOrderResultValidator = v.object({
  paymentId: v.id("payments"),
  razorpayOrderId: v.string(),
  keyId: v.string(),
  amount: v.number(),
  currency: v.string(),
});

/**
 * The ONLY source of a room_booking order's amount — rooms.bookingPricingInfo
 * (server data about the booking) + the fixed lib/rooms.ts price table. A
 * client-supplied amount is never consulted for this purpose, and neither is
 * `args.currency` / RAZORPAY_ORDER_CURRENCY: room bookings are always priced
 * and charged in INR (the task's own fixed table), independent of whatever
 * currency pass orders use on this deployment.
 */
async function roomBookingOrderAmount(
  ctx: ActionCtx,
  refId: string,
): Promise<{ amount: number; currency: "INR"; partnerId: Id<"users"> | null }> {
  const booking: { mode: RoomMode; minutes: RoomMinutes; partnerId: Id<"users"> | null } | null = await ctx.runQuery(
    internal.rooms.bookingPricingInfo,
    { bookingId: refId },
  );
  if (booking === null) invalid(`No room booking found for refId "${refId}"`);
  return { amount: roomChargeInrPaise(booking.mode, booking.minutes), currency: "INR", partnerId: booking.partnerId };
}

async function createOrderCore(
  ctx: ActionCtx,
  args: {
    userId: Id<"users">;
    purpose: "pass" | "room_booking";
    refId: string;
    currency?: string;
    notes?: Record<string, string>;
  },
): Promise<{ paymentId: Id<"payments">; razorpayOrderId: string; keyId: string; amount: number; currency: string }> {
  const config = readRazorpayConfig();
  let notes = validateNotes(args.notes);
  const paymentCapture = args.purpose === "pass"; // pass: auto-capture. room_booking: manual capture.

  let amount: number;
  let currency: string;
  if (args.purpose === "pass") {
    amount = passPriceMinorUnits(args.refId);
    currency = (args.currency ?? readOrderCurrency()).toUpperCase();
  } else {
    const price = await roomBookingOrderAmount(ctx, args.refId);
    amount = price.amount;
    currency = price.currency;
    // The partner is known server-side once the booking is matched — never trust a client-supplied
    // partnerId. This is the only source `applyCapturedTx` uses to attribute a partner payout.
    if (price.partnerId !== null) notes = { ...notes, partnerId: price.partnerId };
  }

  const order = await razorpayCreateOrder(config, {
    amount,
    currency,
    receipt: buildReceipt(args.purpose, args.refId),
    paymentCapture,
    ...(notes !== undefined ? { notes } : {}),
  });

  const paymentId: Id<"payments"> = await ctx.runMutation(internal.payments.recordOrder, {
    userId: args.userId,
    purpose: args.purpose,
    refId: args.refId,
    amount: order.amount,
    currency: order.currency,
    razorpayOrderId: order.id,
    ...(notes !== undefined ? { notes } : {}),
  });

  return { paymentId, razorpayOrderId: order.id, keyId: config.keyId, amount: order.amount, currency: order.currency };
}

/**
 * Creates a Razorpay order and a local `payments` row, and returns exactly
 * what Razorpay Checkout needs to open (order id + the PUBLIC key id — the
 * key secret never leaves the server).
 *
 * Pass purchases: auto-capture. Room bookings: manual capture — the payment
 * sits "authorized" until `captureAuthorizedPayment` runs when the session
 * completes.
 */
export const createOrder = action({
  args: {
    purpose: paymentPurposeValidator,
    refId: v.string(),
    /**
     * Ignored entirely: `currency` only has any effect for `purpose: "pass"`
     * (defaults to RAZORPAY_ORDER_CURRENCY). A room_booking is always priced
     * and charged in INR from the fixed table in lib/rooms.ts, via
     * rooms.bookingPricingInfo — there is no client-supplied amount at all
     * any more (see the room-pricing report).
     */
    currency: v.optional(v.string()),
    notes: v.optional(v.record(v.string(), v.string())),
  },
  returns: createOrderResultValidator,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await createOrderCore(ctx, { userId, ...args });
  },
});

/** Convenience wrapper for the one fully-priced case today: no amount for the client to (mis)supply at all. */
export const createPassOrder = action({
  args: { passId: v.union(v.literal("week"), v.literal("month")) },
  returns: createOrderResultValidator,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await createOrderCore(ctx, {
      userId,
      purpose: "pass",
      refId: args.passId,
    });
  },
});

// ---------------------------------------------------------------------------
// Lookups (internal — used by verifyPayment and the webhook handler)
// ---------------------------------------------------------------------------

const paymentRowValidator = v.object({
  _id: v.id("payments"),
  userId: v.id("users"),
  purpose: paymentPurposeValidator,
  refId: v.string(),
  amount: v.number(),
  currency: v.string(),
  razorpayOrderId: v.string(),
  razorpayPaymentId: v.union(v.string(), v.null()),
  status: paymentStatusValidator,
  notes: v.union(v.record(v.string(), v.string()), v.null()),
});

function toPaymentRow(row: Doc<"payments">): typeof paymentRowValidator.type {
  return {
    _id: row._id,
    userId: row.userId,
    purpose: row.purpose,
    refId: row.refId,
    amount: row.amount,
    currency: row.currency,
    razorpayOrderId: row.razorpayOrderId,
    razorpayPaymentId: row.razorpayPaymentId ?? null,
    status: row.status,
    notes: row.notes ?? null,
  };
}

export const findByOrderId = internalQuery({
  args: { razorpayOrderId: v.string() },
  returns: v.union(paymentRowValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("payments")
      .withIndex("by_razorpayOrderId", (q) => q.eq("razorpayOrderId", args.razorpayOrderId))
      .first();
    return row === null ? null : toPaymentRow(row);
  },
});

export const findByPaymentId = internalQuery({
  args: { razorpayPaymentId: v.string() },
  returns: v.union(paymentRowValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("payments")
      .withIndex("by_razorpayPaymentId", (q) => q.eq("razorpayPaymentId", args.razorpayPaymentId))
      .first();
    return row === null ? null : toPaymentRow(row);
  },
});

export const findByPurposeAndRefId = internalQuery({
  args: { purpose: paymentPurposeValidator, refId: v.string() },
  returns: v.union(paymentRowValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("payments")
      .withIndex("by_purpose_and_refId", (q) => q.eq("purpose", args.purpose).eq("refId", args.refId))
      .order("desc")
      .first();
    return row === null ? null : toPaymentRow(row);
  },
});

/** The caller's own payments (most recent first) — for a future "my purchases" screen. Not otherwise used yet. */
export const mine = query({
  args: {},
  returns: v.array(paymentRowValidator),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("payments")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);
    return rows.map(toPaymentRow);
  },
});

// ---------------------------------------------------------------------------
// Idempotent state transitions (shared by verifyPayment and the webhook)
// ---------------------------------------------------------------------------

async function loadByOrderId(ctx: MutationCtx, razorpayOrderId: string): Promise<Doc<"payments"> | null> {
  return await ctx.db
    .query("payments")
    .withIndex("by_razorpayOrderId", (q) => q.eq("razorpayOrderId", razorpayOrderId))
    .first();
}

async function loadByPaymentId(ctx: MutationCtx, razorpayPaymentId: string): Promise<Doc<"payments"> | null> {
  return await ctx.db
    .query("payments")
    .withIndex("by_razorpayPaymentId", (q) => q.eq("razorpayPaymentId", razorpayPaymentId))
    .first();
}

/** created -> authorized. No-op once already authorized/captured/refunded/failed (idempotent). */
async function applyAuthorizedTx(
  ctx: MutationCtx,
  args: { razorpayOrderId: string; razorpayPaymentId: string },
): Promise<void> {
  const row = await loadByOrderId(ctx, args.razorpayOrderId);
  if (row === null || row.status !== "created") return;
  await ctx.db.patch("payments", row._id, {
    status: "authorized",
    razorpayPaymentId: args.razorpayPaymentId,
    updatedAt: Date.now(),
  });

  if (row.purpose === "room_booking") {
    // "Booking becomes confirmed only after payment is authorized" (rooms task) — idempotent, only "matched" advances.
    await ctx.runMutation(internal.rooms.markBookingConfirmed, { bookingId: row.refId, paymentId: row._id });
  }
}

/** created|authorized -> captured, plus the side effect (grant the pass / record a payout). No-op once captured/refunded. */
async function applyCapturedTx(
  ctx: MutationCtx,
  args: { razorpayOrderId: string; razorpayPaymentId: string },
): Promise<void> {
  const row = await loadByOrderId(ctx, args.razorpayOrderId);
  if (row === null || (row.status !== "created" && row.status !== "authorized")) return;
  await ctx.db.patch("payments", row._id, {
    status: "captured",
    razorpayPaymentId: args.razorpayPaymentId,
    updatedAt: Date.now(),
  });

  if (row.purpose === "pass") {
    const passId = row.refId === "week" || row.refId === "month" ? row.refId : null;
    if (passId !== null) {
      // Idempotent on externalId — a resent webhook or a race with verifyPayment never grants a second pass.
      await ctx.runMutation(internal.passes.grantPass, {
        userId: row.userId,
        passId,
        source: "razorpay",
        externalId: args.razorpayPaymentId,
      });
    }
  } else {
    const partnerId = row.notes?.partnerId;
    if (partnerId !== undefined) {
      const existing = await ctx.db
        .query("partnerPayouts")
        .withIndex("by_payment", (q) => q.eq("paymentId", row._id))
        .first();
      if (existing === null) {
        // The partner's CUT, not the learner's charge (row.amount) — see lib/rooms.ts partnerEarning.
        const booking: { minutes: 5 | 10 | 15 } | null = await ctx.runQuery(internal.rooms.bookingPricingInfo, {
          bookingId: row.refId,
        });
        if (booking !== null) {
          await ctx.db.insert("partnerPayouts", {
            partnerId,
            paymentId: row._id,
            amount: partnerEarningInrPaise(booking.minutes),
            currency: "INR",
            status: "earned",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      }
    }
  }
}

/** created -> failed. No-op past the initial attempt (a captured/authorized payment is never retroactively "failed"). */
async function applyFailedTx(
  ctx: MutationCtx,
  args: { razorpayOrderId: string; razorpayPaymentId?: string; errorDescription?: string },
): Promise<void> {
  const row = await loadByOrderId(ctx, args.razorpayOrderId);
  if (row === null || row.status !== "created") return;
  await ctx.db.patch("payments", row._id, {
    status: "failed",
    ...(args.razorpayPaymentId !== undefined ? { razorpayPaymentId: args.razorpayPaymentId } : {}),
    ...(args.errorDescription !== undefined
      ? { notes: { ...(row.notes ?? {}), failureReason: args.errorDescription.slice(0, MAX_NOTE_LENGTH) } }
      : {}),
    updatedAt: Date.now(),
  });
}

/** authorized|captured -> refunded (an active refund, or a never-captured authorization voided by non-capture). No-op once already refunded/failed. */
async function applyRefundedTx(
  ctx: MutationCtx,
  args: { razorpayPaymentId: string; note?: string },
): Promise<void> {
  const row = await loadByPaymentId(ctx, args.razorpayPaymentId);
  if (row === null || (row.status !== "authorized" && row.status !== "captured")) return;
  await ctx.db.patch("payments", row._id, {
    status: "refunded",
    ...(args.note !== undefined ? { notes: { ...(row.notes ?? {}), refundNote: args.note.slice(0, MAX_NOTE_LENGTH) } } : {}),
    updatedAt: Date.now(),
  });
  const payout = await ctx.db
    .query("partnerPayouts")
    .withIndex("by_payment", (q) => q.eq("paymentId", row._id))
    .first();
  if (payout !== null && payout.status === "earned") {
    // A captured, payout-earning payment just got refunded — hold it for human review rather than silently paying it out.
    await ctx.db.patch("partnerPayouts", payout._id, {
      status: "held",
      notes: `payment refunded${args.note ? `: ${args.note}` : ""}`,
      updatedAt: Date.now(),
    });
  }
}

export const applyAuthorized = internalMutation({
  args: { razorpayOrderId: v.string(), razorpayPaymentId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await applyAuthorizedTx(ctx, args);
    return null;
  },
});

export const applyCaptured = internalMutation({
  args: { razorpayOrderId: v.string(), razorpayPaymentId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await applyCapturedTx(ctx, args);
    return null;
  },
});

export const applyFailed = internalMutation({
  args: { razorpayOrderId: v.string(), razorpayPaymentId: v.optional(v.string()), errorDescription: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await applyFailedTx(ctx, args);
    return null;
  },
});

export const applyRefunded = internalMutation({
  args: { razorpayPaymentId: v.string(), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await applyRefundedTx(ctx, args);
    return null;
  },
});

// ---------------------------------------------------------------------------
// verifyPayment — Checkout's client-side success callback, verified server-side
// ---------------------------------------------------------------------------

const verifyResultValidator = v.object({ verified: v.boolean(), status: paymentStatusValidator });

/**
 * Called right after Razorpay Checkout reports success. Verifies the HMAC
 * signature BEFORE marking anything paid (the hard rule from the task). The
 * webhook is still the source of truth and will apply the same transition a
 * second time (a no-op) if it arrives before or after this call.
 */
export const verifyPayment = action({
  args: {
    razorpayOrderId: v.string(),
    razorpayPaymentId: v.string(),
    razorpaySignature: v.string(),
  },
  returns: verifyResultValidator,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const config: RazorpayConfig = readRazorpayConfig();

    const row: typeof paymentRowValidator.type | null = await ctx.runQuery(internal.payments.findByOrderId, { razorpayOrderId: args.razorpayOrderId });
    if (row === null) notFound("No order matches this payment");
    if (row.userId !== userId) forbidden("This order belongs to another user");

    const ok = await verifyCheckoutSignature({
      orderId: args.razorpayOrderId,
      paymentId: args.razorpayPaymentId,
      signature: args.razorpaySignature,
      keySecret: config.keySecret,
    });
    if (!ok) {
      throw new ConvexError({ code: "invalid_signature", message: "Payment signature did not verify." });
    }

    if (row.purpose === "pass") {
      await ctx.runMutation(internal.payments.applyCaptured, {
        razorpayOrderId: args.razorpayOrderId,
        razorpayPaymentId: args.razorpayPaymentId,
      });
      return { verified: true, status: "captured" as const };
    }
    await ctx.runMutation(internal.payments.applyAuthorized, {
      razorpayOrderId: args.razorpayOrderId,
      razorpayPaymentId: args.razorpayPaymentId,
    });
    return { verified: true, status: "authorized" as const };
  },
});

// ---------------------------------------------------------------------------
// Manual capture / refund-or-void — the room-booking lifecycle hooks
// ---------------------------------------------------------------------------

/**
 * Named + explicitly typed so `internal.payments.*`'s circular self-reference
 * (this module's own `typeof payments`) can never leave the return type
 * unresolved — same reason labs.ts's retry handler is extracted this way.
 */
async function captureAuthorizedPaymentHandler(
  ctx: ActionCtx,
  args: { purpose: "pass" | "room_booking"; refId: string },
): Promise<{ captured: boolean }> {
  const row: typeof paymentRowValidator.type | null = await ctx.runQuery(internal.payments.findByPurposeAndRefId, {
    purpose: args.purpose,
    refId: args.refId,
  });
  if (row === null) notFound("No payment for this purpose/refId");
  if (row.status !== "authorized") return { captured: row.status === "captured" };
  if (row.razorpayPaymentId === null) invalid("Payment has no razorpayPaymentId yet");

  const config = readRazorpayConfig();
  await razorpayCapturePayment(config, { paymentId: row.razorpayPaymentId, amount: row.amount, currency: row.currency });
  await ctx.runMutation(internal.payments.applyCaptured, {
    razorpayOrderId: row.razorpayOrderId,
    razorpayPaymentId: row.razorpayPaymentId,
  });
  return { captured: true };
}

/**
 * Call this when a room-booking session is marked completed. Captures the
 * payment that was authorized at booking time. There is no booking system
 * yet to call this automatically — it is the integration point for one.
 */
export const captureAuthorizedPayment = internalAction({
  args: { purpose: paymentPurposeValidator, refId: v.string() },
  returns: v.object({ captured: v.boolean() }),
  handler: captureAuthorizedPaymentHandler,
});

/**
 * Call this on a no-show or a partner-policy violation. If the payment was
 * never captured, Razorpay has no "void" call — refunds only work on
 * captured payments — so this just marks it refunded locally; Razorpay
 * auto-refunds the actual authorization once the account's capture window
 * passes (see lib/razorpay.ts). If it WAS captured, this issues a real
 * refund through the API.
 */
export const refundOrVoidPayment = internalAction({
  args: { purpose: paymentPurposeValidator, refId: v.string(), reason: v.string() },
  returns: v.object({ refunded: v.boolean(), method: v.union(v.literal("voided_by_non_capture"), v.literal("api_refund"), v.literal("none")) }),
  handler: async (ctx, args) => {
    const row: typeof paymentRowValidator.type | null = await ctx.runQuery(internal.payments.findByPurposeAndRefId, { purpose: args.purpose, refId: args.refId });
    if (row === null) notFound("No payment for this purpose/refId");

    if (row.status === "authorized") {
      if (row.razorpayPaymentId === null) invalid("Payment has no razorpayPaymentId yet");
      await ctx.runMutation(internal.payments.applyRefunded, {
        razorpayPaymentId: row.razorpayPaymentId,
        note: `voided (never captured): ${args.reason}`,
      });
      return { refunded: true, method: "voided_by_non_capture" as const };
    }
    if (row.status === "captured") {
      if (row.razorpayPaymentId === null) invalid("Payment has no razorpayPaymentId yet");
      const config = readRazorpayConfig();
      await razorpayRefundPayment(config, { paymentId: row.razorpayPaymentId, amount: row.amount, notes: { reason: args.reason } });
      await ctx.runMutation(internal.payments.applyRefunded, { razorpayPaymentId: row.razorpayPaymentId, note: args.reason });
      return { refunded: true, method: "api_refund" as const };
    }
    return { refunded: false, method: "none" as const };
  },
});
