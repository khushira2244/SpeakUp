/**
 * Pure Rooms rules: level eligibility, pricing, heartbeat/timeout windows,
 * overlap checking, and weekly-availability -> concrete-slot expansion. No
 * Convex imports, so scripts/verify.ts can test all of it without a
 * deployment — including the atomic-booking and eligibility-filtering cases
 * the task asks to be tested.
 */

export type Level = "starting" | "basic" | "intermediate" | "confident";
export type RoomMode = "now" | "later";
export type RoomMinutes = 5 | 10 | 15;

// ---------------------------------------------------------------------------
// Level eligibility
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<Level, number> = { starting: 0, basic: 1, intermediate: 2, confident: 3 };

export function levelAtLeast(level: Level, minimum: Level): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minimum];
}

/** A partner's speaking test approves them at >= "intermediate". */
export function partnerApproved(level: Level): boolean {
  return levelAtLeast(level, "intermediate");
}

/** A partner is eligible for a learner request when their level is at least the learner's. */
export function partnerEligibleForLearner(partnerLevel: Level, learnerLevel: Level): boolean {
  return levelAtLeast(partnerLevel, learnerLevel);
}

// ---------------------------------------------------------------------------
// Pricing — a fixed table, not a formula. `chargeInrPaise` is the ONLY number
// payments.ts may ever use to create a room_booking Razorpay order (in paise,
// INR's smallest subunit — RAZORPAY_ORDER_CURRENCY stays "INR" for rooms,
// regardless of what the deployment sets it to for passes). `displayUsdCents`
// is for the UI only and is never sent to Razorpay.
// ---------------------------------------------------------------------------

export type RoomPriceEntry = { displayUsdCents: number; chargeInrPaise: number };

/**
 * displayUsdCents: scaled from the original $2.99 (later) / $3.99 (now) per
 * 10 minutes. chargeInrPaise: the task's fixed INR amounts.
 */
const ROOM_PRICE_TABLE: Record<RoomMode, Record<RoomMinutes, RoomPriceEntry>> = {
  later: {
    5: { displayUsdCents: 150, chargeInrPaise: 129_00 },
    10: { displayUsdCents: 299, chargeInrPaise: 249_00 },
    15: { displayUsdCents: 449, chargeInrPaise: 369_00 },
  },
  now: {
    5: { displayUsdCents: 200, chargeInrPaise: 169_00 },
    10: { displayUsdCents: 399, chargeInrPaise: 329_00 },
    15: { displayUsdCents: 599, chargeInrPaise: 489_00 },
  },
};

export function roomPrice(mode: RoomMode, minutes: RoomMinutes): RoomPriceEntry {
  return ROOM_PRICE_TABLE[mode][minutes];
}

/** The trusted charge amount (paise) — payments.ts's only source for a room_booking order's amount. */
export function roomChargeInrPaise(mode: RoomMode, minutes: RoomMinutes): number {
  return roomPrice(mode, minutes).chargeInrPaise;
}

/** USD cents for display only. Never sent to Razorpay. */
export function roomDisplayUsdCents(mode: RoomMode, minutes: RoomMinutes): number {
  return roomPrice(mode, minutes).displayUsdCents;
}

export type PartnerEarningEntry = { earningInrPaise: number; earningUsdCents: number };

/**
 * Flat per session length, independent of now/later (matches the original
 * design: "Partner earns 2.00 per 10 min, scaled the same"). INR amounts are
 * ~66.9% of the "later" charge — the same ratio as the original $2.00-of-$2.99
 * USD scheme — rounded to the nearest paisa; there was no INR number given
 * directly for this, so this ratio is a documented choice, not the task's
 * own literal figure (confirmed with the user).
 */
const PARTNER_EARNING_TABLE: Record<RoomMinutes, PartnerEarningEntry> = {
  5: { earningInrPaise: 86_00, earningUsdCents: 100 },
  10: { earningInrPaise: 167_00, earningUsdCents: 200 },
  15: { earningInrPaise: 247_00, earningUsdCents: 300 },
};

export function partnerEarning(minutes: RoomMinutes): PartnerEarningEntry {
  return PARTNER_EARNING_TABLE[minutes];
}

export function partnerEarningInrPaise(minutes: RoomMinutes): number {
  return partnerEarning(minutes).earningInrPaise;
}

// ---------------------------------------------------------------------------
// Timing windows
// ---------------------------------------------------------------------------

export const HEARTBEAT_TIMEOUT_MS = 2 * 60_000;
export const MATCH_TIMEOUT_MS = 2 * 60_000;
export const REMINDER_BEFORE_START_MS = 10 * 60_000;
export const NO_SHOW_CHECK_AFTER_START_MS = 5 * 60_000;
export const SLOT_WINDOW_DAYS = 7;

/** "Available now" also requires a heartbeat within the last 2 minutes. */
export function partnerIsOnline(lastHeartbeatAt: number | undefined, now: number): boolean {
  return lastHeartbeatAt !== undefined && now - lastHeartbeatAt <= HEARTBEAT_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Overlap
// ---------------------------------------------------------------------------

/** Half-open interval overlap: [aStart, aEnd) intersects [bStart, bEnd). */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// ---------------------------------------------------------------------------
// Weekly availability -> concrete instances (next SLOT_WINDOW_DAYS days)
// ---------------------------------------------------------------------------

export type AvailabilityRule = {
  dayOfWeek: number; // 0 = Sunday .. 6 = Saturday
  startMinute: number; // minutes since local midnight, in `timezone`
  endMinute: number;
  timezone: string; // IANA name
};

export type SlotInstance = { startAt: number; endAt: number };

/**
 * The IANA timezone's UTC offset in minutes at `atEpochMs`. Used as a
 * constant across the whole expansion window (see `expandAvailability`) —
 * correct for the common case, but a DST transition falling inside that
 * window would shift the offset mid-window and this does not account for
 * that. Flagged in the report; a date library would be the real fix.
 */
export function utcOffsetMinutes(timezone: string, atEpochMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(atEpochMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // "hour" can read 24 for midnight in some locales/timezones; normalize.
  const hour = get("hour") % 24;
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asIfUtc - atEpochMs) / 60_000);
}

/**
 * Concrete [startAt, endAt) instances of one weekly rule falling within
 * `windowDays` days starting at `fromEpochMs`, excluding ones that have
 * already ended. The rule's timezone offset is computed once (at
 * `fromEpochMs`) and held constant for the whole window — see
 * `utcOffsetMinutes`.
 */
export function expandAvailability(
  rule: AvailabilityRule,
  fromEpochMs: number,
  windowDays: number = SLOT_WINDOW_DAYS,
): SlotInstance[] {
  const DAY_MS = 86_400_000;
  const offsetMin = utcOffsetMinutes(rule.timezone, fromEpochMs);
  // Treat "epoch + offset" as a UTC-labelled timestamp standing in for local wall-clock time,
  // so plain UTC calendar math (getUTCDay, day boundaries) reads the LOCAL calendar.
  const localNow = fromEpochMs + offsetMin * 60_000;
  const localMidnightToday = Math.floor(localNow / DAY_MS) * DAY_MS;

  const out: SlotInstance[] = [];
  for (let d = 0; d < windowDays; d++) {
    const localMidnight = localMidnightToday + d * DAY_MS;
    const weekday = new Date(localMidnight).getUTCDay();
    if (weekday !== rule.dayOfWeek) continue;
    const localStart = localMidnight + rule.startMinute * 60_000;
    const localEnd = localMidnight + rule.endMinute * 60_000;
    const startAt = localStart - offsetMin * 60_000;
    const endAt = localEnd - offsetMin * 60_000;
    if (endAt > fromEpochMs) out.push({ startAt, endAt });
  }
  return out;
}

/** Slices a slot instance into non-overlapping `minutes`-long bookable starts. */
export function slotStartsWithinInstance(instance: SlotInstance, minutes: RoomMinutes): number[] {
  const durationMs = minutes * 60_000;
  const starts: number[] = [];
  for (let t = instance.startAt; t + durationMs <= instance.endAt; t += durationMs) {
    starts.push(t);
  }
  return starts;
}
