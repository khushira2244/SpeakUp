import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { RazorpayConfigError, parseWebhookEvent, readWebhookSecret, verifyWebhookSignature } from "./lib/razorpay";

const http = httpRouter();

auth.addHttpRoutes(http);

/**
 * Razorpay webhook (Dashboard > Webhooks). Verifies X-Razorpay-Signature over
 * the RAW body (never the re-parsed JSON — see lib/razorpay.ts) before
 * touching anything. Idempotent: every transition it triggers is a no-op if
 * the payment is already in that state or further along, so the same event
 * delivered twice (or payment.authorized arriving after payment.captured)
 * changes nothing.
 */
http.route({
  path: "/razorpay/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const rawBody = await req.text();
    const signature = req.headers.get("x-razorpay-signature");
    if (signature === null) return new Response("Missing X-Razorpay-Signature", { status: 400 });

    let webhookSecret: string;
    try {
      webhookSecret = readWebhookSecret();
    } catch (error) {
      console.error(error instanceof RazorpayConfigError ? error.message : "Razorpay webhook secret misconfigured");
      return new Response("Webhook not configured", { status: 500 });
    }

    const validSignature = await verifyWebhookSignature({ rawBody, signature, webhookSecret });
    if (!validSignature) return new Response("Invalid signature", { status: 400 });

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const parsed = parseWebhookEvent(body);
    switch (parsed.event) {
      case "payment.authorized":
        await ctx.runMutation(internal.payments.applyAuthorized, {
          razorpayOrderId: parsed.orderId,
          razorpayPaymentId: parsed.paymentId,
        });
        break;
      case "payment.captured":
        await ctx.runMutation(internal.payments.applyCaptured, {
          razorpayOrderId: parsed.orderId,
          razorpayPaymentId: parsed.paymentId,
        });
        break;
      case "payment.failed":
        await ctx.runMutation(internal.payments.applyFailed, {
          razorpayOrderId: parsed.orderId,
          ...(parsed.paymentId !== null ? { razorpayPaymentId: parsed.paymentId } : {}),
          ...(parsed.errorDescription !== null ? { errorDescription: parsed.errorDescription } : {}),
        });
        break;
      case "refund.processed":
        await ctx.runMutation(internal.payments.applyRefunded, { razorpayPaymentId: parsed.paymentId });
        break;
      case "unhandled":
        // Still 200 (Razorpay retries non-2xx responses) — just not one of the events we act on.
        console.log(`razorpay webhook: unhandled (${parsed.reason})`);
        break;
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }),
});

export default http;
