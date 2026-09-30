/**
 * Everything the payment screens know about passes and paying lives here.
 * The pay screen talks to Razorpay via <RazorpayCheckout> (real payment,
 * test mode) — see src/components/pay/razorpay-checkout.tsx.
 */

/** true: the screens show "Demo payment" badges and skip Razorpay entirely. Real payment is wired now, so this stays false. */
export const DEMO_MODE = false;

export type PassId = "week" | "month";

export type Pass = {
  id: PassId;
  days: number;
  /** Shown as-is. Change the currency and amount here. */
  price: string;
  /** Shown as-is in "About {price} a day". */
  perDay: string;
};

export const PASSES: readonly Pass[] = [
  { id: "week", days: 7, price: "$4.99", perDay: "$0.71" },
  { id: "month", days: 30, price: "$14.99", perDay: "$0.50" },
];

/** The pass that is selected when the screen opens. */
export const DEFAULT_PASS: PassId = "month";

export function addDays(from: Date, days: number): Date {
  const next = new Date(from);
  next.setDate(next.getDate() + days);
  return next;
}
