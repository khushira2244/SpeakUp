"use client";

/**
 * Shared Razorpay Checkout wrapper: createOrder -> load checkout.js -> open
 * Checkout with the order id + key id the backend returned -> verifyPayment
 * with Checkout's response. The backend never trusts a client-supplied
 * amount (see convex/payments.ts) — this component never sends one either.
 *
 * Checkout.js integration verified against the current Razorpay docs, not
 * from memory: script at https://checkout.razorpay.com/v1/checkout.js,
 * `new Razorpay(options).open()`, the `handler` callback receiving
 * { razorpay_payment_id, razorpay_order_id, razorpay_signature }, cancellation
 * via `modal.ondismiss`, and failures via the `payment.failed` event
 * (`response.error.{code,description,source,step,reason,metadata}`).
 *
 * Render-prop, not a button of its own — the caller decides what the trigger
 * looks like (a "Pay" button today; could be a "Book" button for a room
 * booking later, since `purpose`/`refId` already cover that case too).
 */

import { useCallback, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";

const CHECKOUT_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";
/** Matches --color-accent in globals.css. */
const THEME_COLOR = "#2fe6d5";

type RazorpayHandlerResponse = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

type RazorpayFailedResponse = {
  error: {
    code: string;
    description: string;
    source: string;
    step: string;
    reason: string;
    metadata?: { order_id?: string; payment_id?: string };
  };
};

type RazorpayOptions = {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  order_id: string;
  handler: (response: RazorpayHandlerResponse) => void;
  prefill?: { name?: string; email?: string };
  theme?: { color?: string };
  modal?: { ondismiss?: () => void };
};

type RazorpayInstance = {
  open: () => void;
  on: (event: "payment.failed", handler: (response: RazorpayFailedResponse) => void) => void;
};

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

let scriptLoadPromise: Promise<void> | null = null;

/** Loads checkout.js exactly once, however many RazorpayCheckout instances exist on the page. */
function loadRazorpayScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("Razorpay Checkout requires a browser"));
  if (window.Razorpay) return Promise.resolve();
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load the Razorpay checkout script")));
      return;
    }
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoadPromise = null; // let a later retry try loading again
      reject(new Error("Failed to load the Razorpay checkout script"));
    };
    document.body.appendChild(script);
  });
  return scriptLoadPromise;
}

export type CheckoutOutcome = { status: "success" } | { status: "cancelled" } | { status: "failed"; message: string };

export function RazorpayCheckout({
  purpose,
  refId,
  description,
  onOutcome,
  children,
}: {
  purpose: "pass" | "room_booking";
  refId: string;
  /** Shown inside the Checkout modal itself (Razorpay's own "description" field). */
  description?: string;
  onOutcome: (outcome: CheckoutOutcome) => void;
  children: (state: { pay: () => void; busy: boolean }) => React.ReactNode;
}) {
  const me = useQuery(api.users.me, {});
  const createOrder = useAction(api.payments.createOrder);
  const verifyPayment = useAction(api.payments.verifyPayment);
  const [busy, setBusy] = useState(false);
  const payingRef = useRef(false);

  const finish = useCallback(
    (outcome: CheckoutOutcome) => {
      payingRef.current = false;
      setBusy(false);
      onOutcome(outcome);
    },
    [onOutcome],
  );

  const pay = useCallback(async () => {
    if (payingRef.current) return;
    payingRef.current = true;
    setBusy(true);
    try {
      await loadRazorpayScript();
      // The backend is the ONLY source of the amount — no amount is ever sent from here.
      const order = await createOrder({ purpose, refId });
      const Razorpay = window.Razorpay;
      if (!Razorpay) throw new Error("Razorpay checkout script did not load");

      const rzp = new Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        name: "SpeakUp",
        ...(description !== undefined ? { description } : {}),
        order_id: order.razorpayOrderId,
        prefill: { name: me?.name ?? undefined, email: me?.email ?? undefined },
        theme: { color: THEME_COLOR },
        handler: (response) => {
          void (async () => {
            try {
              await verifyPayment({
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              });
              finish({ status: "success" });
            } catch (error) {
              finish({ status: "failed", message: error instanceof Error ? error.message : String(error) });
            }
          })();
        },
        modal: {
          ondismiss: () => finish({ status: "cancelled" }),
        },
      });
      rzp.on("payment.failed", (response) => {
        finish({ status: "failed", message: response.error.description || response.error.reason });
      });
      rzp.open();
    } catch (error) {
      finish({ status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }, [purpose, refId, description, me, createOrder, verifyPayment, finish]);

  return <>{children({ pay: () => void pay(), busy })}</>;
}
