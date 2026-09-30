/**
 * Pure access-pass rules. No Convex imports, so scripts/verify.ts can test
 * the stacking and coverage math without a deployment.
 */

export const PASS_TYPES = ["week", "month"] as const;
export type PassType = (typeof PASS_TYPES)[number];

export const PASS_DAYS: Record<PassType, number> = { week: 7, month: 30 };
export const DAY_MS = 86_400_000;

/**
 * Where a newly bought pass sits in time. Renewals stack: if the caller's
 * latest pass is still running, the new one starts when it ends; otherwise
 * it starts now.
 */
export function passWindow(args: {
  passId: PassType;
  now: number;
  latestEndsAt: number | null;
}): { startsAt: number; endsAt: number } {
  const startsAt =
    args.latestEndsAt !== null && args.latestEndsAt > args.now ? args.latestEndsAt : args.now;
  return { startsAt, endsAt: startsAt + PASS_DAYS[args.passId] * DAY_MS };
}

/** True when `pass` covers the instant `now` (start inclusive, end exclusive). */
export function passCoversNow(
  pass: { startsAt: number; endsAt: number } | null,
  now: number,
): boolean {
  return pass !== null && pass.startsAt <= now && now < pass.endsAt;
}

/**
 * Demo passes bypass payment, so they are OFF unless the deployment sets
 * ALLOW_DEMO_PASSES to exactly "true". Anything else — unset, "false",
 * "TRUE", "1" — keeps them disabled.
 */
export function demoPassesEnabled(value: string | undefined): boolean {
  return value === "true";
}
