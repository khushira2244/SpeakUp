/**
 * Razorpay integration: a thin REST wrapper (Basic Auth over `fetch`, no SDK
 * — same approach as lib/llm.ts) plus HMAC-SHA256 signature verification for
 * both Checkout's client-side payment verification and server-to-server
 * webhooks.
 *
 * Runs in the default Convex runtime (an edge-runtime-like V8 isolate): Web
 * Crypto (`crypto.subtle`) and `fetch` are both built in, so this file needs
 * no `"use node";` and no `razorpay` npm dependency. `btoa` is NOT assumed
 * available — Basic Auth is base64-encoded by hand below, since a missing
 * global there would silently break every API call.
 *
 * API shapes (order, capture, refund, webhook payloads, the order_id|payment_id
 * signature formula, and the 3-day default manual-capture auto-refund window)
 * were confirmed against Razorpay's own docs — see the payments-build report.
 *
 * SECURITY: RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are read from the
 * deployment env only inside actions/httpActions, and never returned to a
 * client. RAZORPAY_KEY_ID is a public identifier (not a secret) — it is
 * returned to the client so Razorpay Checkout can open with it.
 */

export class RazorpayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RazorpayConfigError";
  }
}

export class RazorpayApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RazorpayApiError";
    this.status = status;
  }
}

export type RazorpayConfig = { keyId: string; keySecret: string };

/** Throws RazorpayConfigError (not retried) when the deployment is missing credentials. */
export function readRazorpayConfig(): RazorpayConfig {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || keyId.trim().length === 0) {
    throw new RazorpayConfigError(
      "RAZORPAY_KEY_ID is not set on this Convex deployment. Set it with: npx convex env set RAZORPAY_KEY_ID <key>",
    );
  }
  if (!keySecret || keySecret.trim().length === 0) {
    throw new RazorpayConfigError(
      "RAZORPAY_KEY_SECRET is not set on this Convex deployment. Set it with: npx convex env set RAZORPAY_KEY_SECRET <secret>",
    );
  }
  return { keyId: keyId.trim(), keySecret: keySecret.trim() };
}

export function readWebhookSecret(): string {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || secret.trim().length === 0) {
    throw new RazorpayConfigError(
      "RAZORPAY_WEBHOOK_SECRET is not set on this Convex deployment. Set it with: npx convex env set RAZORPAY_WEBHOOK_SECRET <secret>",
    );
  }
  return secret.trim();
}

/** The currency actual Razorpay orders are created in. Defaults to INR — see the payments-build report on USD/test-mode. */
export function readOrderCurrency(): string {
  const currency = process.env.RAZORPAY_ORDER_CURRENCY?.trim();
  return currency && currency.length > 0 ? currency.toUpperCase() : "INR";
}

// ---------------------------------------------------------------------------
// Base64 (hand-rolled: `btoa` is not assumed available in every runtime)
// ---------------------------------------------------------------------------

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? "=" : BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? "=" : BASE64_CHARS[b2 & 0x3f];
  }
  return out;
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 signature verification (Web Crypto)
// ---------------------------------------------------------------------------

function hexEncode(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return hexEncode(signature);
}

/** Constant-time comparison — never use `===` on a signature. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Checkout's post-payment verification: `HMAC-SHA256("<order_id>|<payment_id>", key_secret)`.
 * MUST pass before anything is marked paid from the client-reported success callback.
 */
export async function verifyCheckoutSignature(args: {
  orderId: string;
  paymentId: string;
  signature: string;
  keySecret: string;
}): Promise<boolean> {
  const expected = await hmacSha256Hex(args.keySecret, `${args.orderId}|${args.paymentId}`);
  return timingSafeEqualHex(expected, args.signature.trim().toLowerCase());
}

/**
 * Webhook verification: `HMAC-SHA256(<raw request body>, webhook_secret)`, compared
 * against the `X-Razorpay-Signature` header. MUST be computed over the raw,
 * unparsed body — re-serialized JSON will not match.
 */
export async function verifyWebhookSignature(args: {
  rawBody: string;
  signature: string;
  webhookSecret: string;
}): Promise<boolean> {
  const expected = await hmacSha256Hex(args.webhookSecret, args.rawBody);
  return timingSafeEqualHex(expected, args.signature.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// REST calls
// ---------------------------------------------------------------------------

const API_BASE = "https://api.razorpay.com/v1";

async function razorpayFetch(
  config: RazorpayConfig,
  path: string,
  args: { method: "GET" | "POST"; body?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const auth = base64Encode(`${config.keyId}:${config.keySecret}`);
  const response = await fetch(`${API_BASE}${path}`, {
    method: args.method,
    headers: {
      authorization: `Basic ${auth}`,
      "content-type": "application/json",
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const record = json as { error?: { description?: string; code?: string } };
    const message = record.error?.description ?? record.error?.code ?? `HTTP ${response.status}`;
    throw new RazorpayApiError(message, response.status);
  }
  return json as Record<string, unknown>;
}

export type RazorpayOrder = { id: string; amount: number; currency: string; status: string };

/**
 * POST /v1/orders. `paymentCapture: true` -> auto-capture on payment success
 * (used for pass purchases); `false` -> the payment stays "authorized" until
 * an explicit capture call (used for room bookings).
 */
export async function createOrder(
  config: RazorpayConfig,
  args: {
    amount: number;
    currency: string;
    receipt: string;
    paymentCapture: boolean;
    notes?: Record<string, string>;
  },
): Promise<RazorpayOrder> {
  const json = await razorpayFetch(config, "/orders", {
    method: "POST",
    body: {
      amount: args.amount,
      currency: args.currency,
      receipt: args.receipt,
      payment_capture: args.paymentCapture ? 1 : 0,
      ...(args.notes !== undefined ? { notes: args.notes } : {}),
    },
  });
  return json as unknown as RazorpayOrder;
}

export type RazorpayPayment = { id: string; status: string; amount: number; currency: string };

/**
 * POST /v1/payments/:id/capture. Only valid while the payment is "authorized"
 * — Razorpay auto-refunds an authorized payment left uncaptured past the
 * account's manual-capture window (3 days by default; configurable 12
 * minutes–3 days in Dashboard > Payments Capture settings). `amount` must
 * equal the amount that was authorized.
 */
export async function capturePayment(
  config: RazorpayConfig,
  args: { paymentId: string; amount: number; currency: string },
): Promise<RazorpayPayment> {
  const json = await razorpayFetch(config, `/payments/${encodeURIComponent(args.paymentId)}/capture`, {
    method: "POST",
    body: { amount: args.amount, currency: args.currency },
  });
  return json as unknown as RazorpayPayment;
}

export type RazorpayRefund = { id: string; status: string; amount: number; payment_id: string };

// ---------------------------------------------------------------------------
// Webhook payload parsing (pure — no Convex imports, unit-testable)
// ---------------------------------------------------------------------------

/**
 * The events the task asks for. Every other event still gets a 200 (so
 * Razorpay does not retry it forever) but is otherwise ignored — `unhandled`
 * carries a reason for the caller to log.
 */
export type RazorpayWebhookEvent =
  | { event: "payment.authorized"; orderId: string; paymentId: string }
  | { event: "payment.captured"; orderId: string; paymentId: string }
  | { event: "payment.failed"; orderId: string; paymentId: string | null; errorDescription: string | null }
  | { event: "refund.processed"; paymentId: string }
  | { event: "unhandled"; reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Never throws: an unrecognized or malformed body becomes `{ event: "unhandled" }`
 * rather than a crash, since a webhook body is arbitrary external input.
 */
export function parseWebhookEvent(body: unknown): RazorpayWebhookEvent {
  const root = asRecord(body);
  const eventName = root ? asString(root.event) : null;
  if (root === null || eventName === null) return { event: "unhandled", reason: "not an object, or missing \"event\"" };

  const payload = asRecord(root.payload);
  const paymentEntity = () => (payload ? asRecord(asRecord(payload.payment)?.entity) : null);
  const refundEntity = () => (payload ? asRecord(asRecord(payload.refund)?.entity) : null);

  if (eventName === "payment.authorized" || eventName === "payment.captured") {
    const entity = paymentEntity();
    const orderId = entity ? asString(entity.order_id) : null;
    const paymentId = entity ? asString(entity.id) : null;
    if (orderId && paymentId) return { event: eventName, orderId, paymentId };
    return { event: "unhandled", reason: `${eventName}: missing payload.payment.entity.order_id/id` };
  }
  if (eventName === "payment.failed") {
    const entity = paymentEntity();
    const orderId = entity ? asString(entity.order_id) : null;
    if (orderId === null) return { event: "unhandled", reason: "payment.failed: missing payload.payment.entity.order_id" };
    return {
      event: "payment.failed",
      orderId,
      paymentId: entity ? asString(entity.id) : null,
      errorDescription: entity ? asString(entity.error_description) : null,
    };
  }
  if (eventName === "refund.processed") {
    const entity = refundEntity();
    const paymentId = entity ? asString(entity.payment_id) : null;
    if (paymentId) return { event: "refund.processed", paymentId };
    return { event: "unhandled", reason: "refund.processed: missing payload.refund.entity.payment_id" };
  }
  return { event: "unhandled", reason: `unrecognized event "${eventName}"` };
}

/**
 * POST /v1/payments/:id/refund. Razorpay only allows refunding a payment
 * that is already "captured" — there is no separate "void" call for a
 * merely-authorized payment (see the report for how voiding is handled).
 */
export async function refundPayment(
  config: RazorpayConfig,
  args: { paymentId: string; amount?: number; notes?: Record<string, string> },
): Promise<RazorpayRefund> {
  const json = await razorpayFetch(config, `/payments/${encodeURIComponent(args.paymentId)}/refund`, {
    method: "POST",
    body: {
      ...(args.amount !== undefined ? { amount: args.amount } : {}),
      speed: "normal",
      ...(args.notes !== undefined ? { notes: args.notes } : {}),
    },
  });
  return json as unknown as RazorpayRefund;
}
