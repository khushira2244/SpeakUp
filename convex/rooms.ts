/**
 * Rooms: learner room requests, "now"/"later" matching, session lifecycle,
 * scripts, and the mockup-screen queries. Payment is the existing
 * convex/payments.ts backend (`purpose: "room_booking"`) — see
 * bookingPricingInfo / markBookingConfirmed for the two hooks into it.
 *
 * Atomicity ("two learners, one slot" / "first accept wins"): every mutation
 * here follows Convex's read-then-write OCC pattern — it QUERIES the exact
 * range a conflicting write would land in before inserting/patching, so two
 * concurrent calls that would both succeed independently are guaranteed to
 * have one of them retried and lose, rather than needing a separate lock.
 */

import { ConvexError, v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  levelValidator,
  partnerStatusValidator,
  payoutStatusValidator,
  roomMinutesValidator,
  roomModeValidator,
  roomScriptLineValidator,
  roomStatusValidator,
  targetLanguageValidator,
} from "./schema";
import { forbidden, invalid, loadActiveGoal, notFound, requireUserId } from "./lib/authz";
import { generationLanguages, LANGUAGE_NAMES, readLanguageProfile, type KnownLanguage, type TargetLanguage } from "./lib/languages";
import { llmJson } from "./lib/llm";
import { llmRecorder } from "./llmMetrics";
import {
  HEARTBEAT_TIMEOUT_MS,
  MATCH_TIMEOUT_MS,
  NO_SHOW_CHECK_AFTER_START_MS,
  partnerEarning,
  REMINDER_BEFORE_START_MS,
  SLOT_WINDOW_DAYS,
  expandAvailability,
  partnerEligibleForLearner,
  partnerIsOnline,
  rangesOverlap,
  roomDisplayUsdCents,
  slotStartsWithinInstance,
  type AvailabilityRule,
  type Level,
  type RoomMinutes,
  type RoomMode,
} from "./lib/rooms";
import { AUTO_END_GRACE_MS } from "./lib/liveRoom";
import { roomScriptJsonSchema, scriptLineBounds, validateRoomScript } from "./lib/roomScript";

const MAX_SCENARIO = 300;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** "Taken" statuses that block booking the same partner over an overlapping time. */
const BLOCKING_STATUSES = ["matched", "confirmed", "in_progress", "completed"] as const;

export async function requireOwnedBooking(ctx: QueryCtx | MutationCtx, bookingId: Id<"roomBookings">, userId: Id<"users">): Promise<Doc<"roomBookings">> {
  const booking = await ctx.db.get("roomBookings", bookingId);
  if (booking === null) notFound("Booking not found");
  if (booking.learnerId !== userId && booking.partnerId !== userId) forbidden("This booking belongs to another user");
  return booking;
}

async function latestLevelForGoal(ctx: QueryCtx | MutationCtx, goalId: Id<"goals">, userId: Id<"users">): Promise<Level | null> {
  const result = await ctx.db
    .query("levelResults")
    .withIndex("by_goal", (q) => q.eq("goalId", goalId))
    .order("desc")
    .first();
  return result !== null && result.userId === userId ? result.level : null;
}

// ---------------------------------------------------------------------------
// Room request: "now"
// ---------------------------------------------------------------------------

const bookingIdResult = v.object({ bookingId: v.id("roomBookings") });

export const requestRoomNow = mutation({
  args: { scenario: v.string(), minutes: roomMinutesValidator, targetLanguage: targetLanguageValidator },
  returns: bookingIdResult,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const scenario = args.scenario.trim();
    if (scenario.length === 0) invalid("scenario must not be empty");
    if (scenario.length > MAX_SCENARIO) invalid(`scenario must be at most ${MAX_SCENARIO} characters`);

    const goal = await loadActiveGoal(ctx, userId);
    if (goal === null) invalid("You need an active goal (goals.setGoal) before requesting a room");
    const learnerLevel = await latestLevelForGoal(ctx, goal._id, userId);
    if (learnerLevel === null) invalid("Finish your level check before requesting a room");

    const now = Date.now();
    const bookingId = await ctx.db.insert("roomBookings", {
      learnerId: userId,
      targetLanguage: args.targetLanguage,
      learnerLevel,
      scenario,
      minutes: args.minutes,
      mode: "now",
      status: "requested",
      scheduledStartAt: now,
      scheduledEndAt: now + args.minutes * 60_000,
      matchDeadlineAt: now + MATCH_TIMEOUT_MS,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(MATCH_TIMEOUT_MS, internal.rooms.checkNoPartnerTimeout, { bookingId });
    return { bookingId };
  },
});

/** If nobody accepted a "now" request within the match window, it becomes "no_partner". */
export const checkNoPartnerTimeout = internalMutation({
  args: { bookingId: v.id("roomBookings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const booking = await ctx.db.get("roomBookings", args.bookingId);
    if (booking === null || booking.status !== "requested") return null; // already matched, or gone
    await ctx.db.patch("roomBookings", args.bookingId, { status: "no_partner", updatedAt: Date.now() });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Matching: "now" — visibility + first-accept-wins
// ---------------------------------------------------------------------------

const nowRequestValidator = v.object({
  _id: v.id("roomBookings"),
  scenario: v.string(),
  targetLanguage: targetLanguageValidator,
  learnerLevel: levelValidator,
  minutes: roomMinutesValidator,
  matchDeadlineAt: v.number(),
});

/** "now" requests visible to the caller: same language, caller approved and eligible (their level >= the learner's), not yet expired. */
export const openNowRequests = query({
  args: {},
  returns: v.array(nowRequestValidator),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const now = Date.now();
    const profiles = await ctx.db
      .query("partnerProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(10);
    // "now" requests are only visible while the partner is actually marked available AND has a fresh heartbeat.
    const approved = profiles.filter(
      (p) => p.status === "approved" && p.level !== undefined && p.availableNow && partnerIsOnline(p.lastHeartbeatAt, now),
    );
    if (approved.length === 0) return [];

    const out: Array<typeof nowRequestValidator.type> = [];
    for (const profile of approved) {
      const requests = await ctx.db
        .query("roomBookings")
        .withIndex("by_targetLanguage_and_mode_and_status", (q) =>
          q.eq("targetLanguage", profile.targetLanguage).eq("mode", "now").eq("status", "requested"),
        )
        .take(100);
      for (const r of requests) {
        if (r.matchDeadlineAt !== undefined && r.matchDeadlineAt <= now) continue;
        if (!partnerEligibleForLearner(profile.level as Level, r.learnerLevel)) continue;
        out.push({
          _id: r._id,
          scenario: r.scenario,
          targetLanguage: r.targetLanguage,
          learnerLevel: r.learnerLevel,
          minutes: r.minutes,
          matchDeadlineAt: r.matchDeadlineAt ?? now,
        });
      }
    }
    out.sort((a, b) => a.matchDeadlineAt - b.matchDeadlineAt);
    return out;
  },
});

/**
 * First accept wins: reads then checks `status === "requested"` before
 * writing, so Convex's OCC forces a concurrent second acceptor to retry,
 * re-read the now-"matched" row, and fail its own check — never silently
 * double-match.
 */
export const acceptRoomRequest = mutation({
  args: { bookingId: v.id("roomBookings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const booking = await ctx.db.get("roomBookings", args.bookingId);
    if (booking === null) notFound("Booking not found");
    if (booking.mode !== "now") invalid("Only \"now\" requests are accepted this way — see requestRoomLater");
    if (booking.status !== "requested") {
      throw new ConvexError({ code: "already_matched", message: "This request was already matched (or expired)." });
    }
    if (booking.matchDeadlineAt !== undefined && booking.matchDeadlineAt <= Date.now()) {
      throw new ConvexError({ code: "expired", message: "The match window for this request has passed." });
    }

    const profile = await ctx.db
      .query("partnerProfiles")
      .withIndex("by_user_and_language", (q) => q.eq("userId", userId).eq("targetLanguage", booking.targetLanguage))
      .first();
    if (profile === null || profile.status !== "approved" || profile.level === undefined) {
      forbidden("You are not an approved partner for this language");
    }
    if (!profile.availableNow || !partnerIsOnline(profile.lastHeartbeatAt, Date.now())) {
      forbidden("You are not marked available now (or your heartbeat has gone stale)");
    }
    if (!partnerEligibleForLearner(profile.level as Level, booking.learnerLevel)) {
      forbidden("Your level is not high enough for this learner's request");
    }

    await ctx.db.patch("roomBookings", args.bookingId, {
      status: "matched",
      partnerId: userId,
      partnerProfileId: profile._id,
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Matching: "later" — atomic slot booking
// ---------------------------------------------------------------------------

const slotValidator = v.object({ partnerProfileId: v.id("partnerProfiles"), partnerId: v.id("users"), startAt: v.number(), endAt: v.number() });
const slotWithTakenValidator = v.object({
  partnerProfileId: v.id("partnerProfiles"),
  partnerId: v.id("users"),
  startAt: v.number(),
  endAt: v.number(),
  taken: v.boolean(),
});

/** Shared by availableSlots and slotAvailability: every concrete slot start in the next 7 days from approved+eligible partners, each tagged `taken`. */
async function computeSlotAvailability(
  ctx: QueryCtx,
  args: { targetLanguage: TargetLanguage; minutes: RoomMinutes; level: Level },
): Promise<Array<typeof slotWithTakenValidator.type>> {
  const now = Date.now();
  const partners = await ctx.db
    .query("partnerProfiles")
    .withIndex("by_language_and_status", (q) => q.eq("targetLanguage", args.targetLanguage).eq("status", "approved"))
    .take(200);
  const eligible = partners.filter((p) => p.level !== undefined && partnerEligibleForLearner(p.level as Level, args.level));

  const out: Array<typeof slotWithTakenValidator.type> = [];
  for (const partner of eligible) {
    const rules = await ctx.db
      .query("partnerAvailability")
      .withIndex("by_partnerProfile", (q) => q.eq("partnerProfileId", partner._id))
      .take(50);
    const existingBookings = await ctx.db
      .query("roomBookings")
      .withIndex("by_partner_and_scheduledStartAt", (q) => q.eq("partnerId", partner.userId))
      .take(500);
    const taken = existingBookings.filter(
      (b) => (BLOCKING_STATUSES as readonly string[]).includes(b.status) && b.scheduledStartAt !== undefined && b.scheduledEndAt !== undefined,
    );

    for (const rule of rules) {
      const instances = expandAvailability(rule as AvailabilityRule, now, SLOT_WINDOW_DAYS);
      for (const instance of instances) {
        for (const startAt of slotStartsWithinInstance(instance, args.minutes)) {
          // expandAvailability only drops an instance once it has fully ENDED (see its own
          // comment) — a still-open instance that started earlier today (e.g. an all-day rule)
          // yields slot starts before "now" too, which requestRoomLater would then reject.
          if (startAt < now) continue;
          const endAt = startAt + args.minutes * 60_000;
          const isTaken = taken.some((b) => rangesOverlap(startAt, endAt, b.scheduledStartAt!, b.scheduledEndAt!));
          out.push({ partnerProfileId: partner._id, partnerId: partner.userId, startAt, endAt, taken: isTaken });
        }
      }
    }
  }
  out.sort((a, b) => a.startAt - b.startAt);
  return out;
}

/** Concrete bookable (free) slot starts, for the next 7 days, from approved+eligible partners for this language/level/duration. */
export const availableSlots = query({
  args: { targetLanguage: targetLanguageValidator, minutes: roomMinutesValidator, level: levelValidator },
  returns: v.array(slotValidator),
  handler: async (ctx, args) => {
    await requireUserId(ctx);
    const all = await computeSlotAvailability(ctx, args);
    return all.filter((s) => !s.taken).map(({ taken: _taken, ...rest }) => rest);
  },
});

/** Same as availableSlots, but includes already-taken slots (tagged `taken: true`) so the "When" screen can show them greyed out. */
export const slotAvailability = query({
  args: { targetLanguage: targetLanguageValidator, minutes: roomMinutesValidator, level: levelValidator },
  returns: v.array(slotWithTakenValidator),
  handler: async (ctx, args) => {
    await requireUserId(ctx);
    return await computeSlotAvailability(ctx, args);
  },
});

/** Atomically reserves one concrete slot — see the file header on how OCC makes this safe under concurrency. */
export const requestRoomLater = mutation({
  args: {
    scenario: v.string(),
    minutes: roomMinutesValidator,
    targetLanguage: targetLanguageValidator,
    partnerProfileId: v.id("partnerProfiles"),
    startAt: v.number(),
  },
  returns: bookingIdResult,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const scenario = args.scenario.trim();
    if (scenario.length === 0) invalid("scenario must not be empty");
    if (scenario.length > MAX_SCENARIO) invalid(`scenario must be at most ${MAX_SCENARIO} characters`);
    if (!Number.isFinite(args.startAt) || args.startAt < Date.now() - 60_000) invalid("startAt must be a valid, non-past time");

    const goal = await loadActiveGoal(ctx, userId);
    if (goal === null) invalid("You need an active goal (goals.setGoal) before requesting a room");
    const learnerLevel = await latestLevelForGoal(ctx, goal._id, userId);
    if (learnerLevel === null) invalid("Finish your level check before requesting a room");

    const partner = await ctx.db.get("partnerProfiles", args.partnerProfileId);
    if (partner === null) notFound("Partner not found");
    if (partner.targetLanguage !== args.targetLanguage) invalid("Partner does not offer this target language");
    if (partner.status !== "approved" || partner.level === undefined) invalid("Partner is not approved");
    if (!partnerEligibleForLearner(partner.level as Level, learnerLevel)) invalid("Partner's level is below yours");

    const endAt = args.startAt + args.minutes * 60_000;

    // The slot must fall inside a real weekly window.
    const rules = await ctx.db
      .query("partnerAvailability")
      .withIndex("by_partnerProfile", (q) => q.eq("partnerProfileId", partner._id))
      .take(50);
    const now = Date.now();
    const validStart = rules.some((rule) =>
      expandAvailability(rule as AvailabilityRule, now, SLOT_WINDOW_DAYS).some(
        (instance) => instance.startAt <= args.startAt && endAt <= instance.endAt,
      ),
    );
    if (!validStart) invalid("That start time is not inside this partner's availability");

    // Read-before-write: this range scan is what makes a concurrent double-book impossible (see file header).
    const existing = await ctx.db
      .query("roomBookings")
      .withIndex("by_partner_and_scheduledStartAt", (q) => q.eq("partnerId", partner.userId))
      .take(500);
    const conflict = existing.some(
      (b) =>
        (BLOCKING_STATUSES as readonly string[]).includes(b.status) &&
        b.scheduledStartAt !== undefined &&
        b.scheduledEndAt !== undefined &&
        rangesOverlap(args.startAt, endAt, b.scheduledStartAt, b.scheduledEndAt),
    );
    if (conflict) {
      throw new ConvexError({ code: "slot_taken", message: "That slot was just booked by someone else." });
    }

    const bookingId = await ctx.db.insert("roomBookings", {
      learnerId: userId,
      targetLanguage: args.targetLanguage,
      learnerLevel,
      scenario,
      minutes: args.minutes,
      mode: "later",
      status: "matched",
      partnerId: partner.userId,
      partnerProfileId: partner._id,
      scheduledStartAt: args.startAt,
      scheduledEndAt: endAt,
      createdAt: now,
      updatedAt: now,
    });
    return { bookingId };
  },
});

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

export const joinWaitlist = mutation({
  args: { targetLanguage: targetLanguageValidator, minutes: roomMinutesValidator, fromBookingId: v.optional(v.id("roomBookings")) },
  returns: v.id("roomWaitlist"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    if (args.fromBookingId !== undefined) await requireOwnedBooking(ctx, args.fromBookingId, userId);
    return await ctx.db.insert("roomWaitlist", {
      learnerId: userId,
      targetLanguage: args.targetLanguage,
      minutes: args.minutes,
      ...(args.fromBookingId !== undefined ? { fromBookingId: args.fromBookingId } : {}),
      createdAt: Date.now(),
    });
  },
});

export const myWaitlistEntries = query({
  args: {},
  returns: v.array(v.object({ _id: v.id("roomWaitlist"), targetLanguage: targetLanguageValidator, minutes: roomMinutesValidator, createdAt: v.number() })),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("roomWaitlist")
      .withIndex("by_learner", (q) => q.eq("learnerId", userId))
      .order("desc")
      .take(50);
    return rows.map((r) => ({ _id: r._id, targetLanguage: r.targetLanguage, minutes: r.minutes, createdAt: r.createdAt }));
  },
});

// ---------------------------------------------------------------------------
// Script generation (LLM, once) + free learner edits (versioned, no LLM)
// ---------------------------------------------------------------------------

const SCRIPT_SYSTEM = `You are writing a short two-person practice dialogue for SpeakUp, a language app.
You are given a learner's goal words in the language they are learning, each with a short ID, plus a scenario and the learner's level.
Write an ordered back-and-forth script between "learner" and "partner" that rehearses that scenario, using ONLY the supplied words.
You must refer to a word ONLY by its ID in "wordIds" — never write the word itself in that field (the "text" field is where the actual line goes).
Every line also needs a "meaning": a plain translation of that exact line into the learner's own primary language, so the learner knows what they are about to say before they say it — this is shown right under the line, never guessed at.
A strict validator checks your output, so follow the required shape exactly.`;

function scriptPrompt(args: {
  scenario: string;
  learnerLevel: Level;
  targetLanguage: TargetLanguage;
  primaryLanguage: KnownLanguage;
  words: ReadonlyArray<{ id: string; word: string; meaning: string }>;
  lineCount: { min: number; max: number };
}): string {
  const target = LANGUAGE_NAMES[args.targetLanguage];
  const primary = LANGUAGE_NAMES[args.primaryLanguage];
  return `Scenario: "${args.scenario}"
Learner's level: ${args.learnerLevel}
Language being practised (write dialogue lines in this): ${target} (${args.targetLanguage})
Learner's primary language (for context only — every line's "text" is still in ${target}): ${primary}

The learner's goal words, by ID. A line's "wordIds" may ONLY reference these:
${args.words.map((w) => `${w.id}: ${w.word} (${w.meaning})`).join("\n")}

Return a JSON object with one field, "lines": an array of ${args.lineCount.min} to ${args.lineCount.max} objects, alternating (or close to alternating) between the two roles, in the order they are said. Each object:
  - "role": "learner" or "partner".
  - "text": one short, natural ${target} sentence for that role to say, matching the learner's level (${args.learnerLevel} — keep it simple for "starting"/"basic", more natural for "intermediate"/"confident").
  - "meaning": that same line translated into ${primary}, plainly and naturally — never leave this out, and never translate into any language other than ${primary}.
  - "wordIds": the IDs (from the list above) of the goal words THIS line actually uses (can be an empty array if the line uses none).

At least one line must have role "learner" and at least one must have role "partner". Do not add any other fields.`;
}

async function generateScriptHandler(ctx: ActionCtx, args: { bookingId: Id<"roomBookings"> }): Promise<{ version: number; generated: boolean }> {
  const userId = await requireUserId(ctx);
  const context: {
    scenario: string;
    minutes: RoomMinutes;
    learnerLevel: Level;
    targetLanguage: TargetLanguage;
    primaryLanguage: KnownLanguage;
    words: Array<{ word: string; meaning: string }>;
    latestVersion: number;
  } = await ctx.runQuery(internal.rooms.scriptContext, { bookingId: args.bookingId, userId });

  if (context.latestVersion > 0) return { version: context.latestVersion, generated: false }; // "generated once"

  const words = context.words.map((w, i) => ({ id: `w${i}`, word: w.word, meaning: w.meaning }));
  const wordIds = new Set(words.map((w) => w.id));
  const wordById = new Map(context.words.map((w, i) => [`w${i}`, w]));
  const bounds = scriptLineBounds(context.minutes);

  const validated = await llmJson({
    system: SCRIPT_SYSTEM,
    user: scriptPrompt({
      scenario: context.scenario,
      learnerLevel: context.learnerLevel,
      targetLanguage: context.targetLanguage,
      primaryLanguage: context.primaryLanguage,
      words,
      lineCount: bounds,
    }),
    schemaName: "room_script",
    schema: roomScriptJsonSchema([...wordIds]),
    validate: (raw) => validateRoomScript(raw, { wordIds, minutes: context.minutes }),
    timeoutMs: 90_000,
    maxTokens: 6_000,
    recordCall: llmRecorder(ctx),
  });

  const lines = validated.lines.map((l) => ({
    role: l.role,
    text: l.text,
    meaning: l.meaning,
    words: l.wordIds.map((id) => wordById.get(id)!.word),
  }));

  const version: number = await ctx.runMutation(internal.rooms.saveScriptVersion, {
    bookingId: args.bookingId,
    lines,
    generatedByLLM: true,
  });
  return { version, generated: true };
}

/** Generates the script once, from the learner's own goal vocabulary. A second call is a no-op (returns the existing version). */
export const generateScript = action({
  args: { bookingId: v.id("roomBookings") },
  returns: v.object({ version: v.number(), generated: v.boolean() }),
  handler: generateScriptHandler,
});

const scriptContextValidator = v.object({
  scenario: v.string(),
  minutes: roomMinutesValidator,
  learnerLevel: levelValidator,
  targetLanguage: targetLanguageValidator,
  primaryLanguage: v.union(v.literal("en"), v.literal("hi"), v.literal("te")),
  words: v.array(v.object({ word: v.string(), meaning: v.string() })),
  latestVersion: v.number(),
});

export const scriptContext = internalQuery({
  args: { bookingId: v.id("roomBookings"), userId: v.id("users") },
  returns: scriptContextValidator,
  handler: async (ctx, args) => {
    const booking = await ctx.db.get("roomBookings", args.bookingId);
    if (booking === null) notFound("Booking not found");
    if (booking.learnerId !== args.userId) forbidden("Only the learner who made this booking can generate its script");

    const goal = await loadActiveGoal(ctx, args.userId);
    if (goal === null) throw new Error("Learner has no active goal; cannot generate a script");
    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
      .first();
    if (targets === null) throw new Error("Learner's goal targets are not generated yet");
    const user = await ctx.db.get("users", args.userId);
    const languages = generationLanguages(targets, user === null ? null : readLanguageProfile(user));

    const latest = await ctx.db
      .query("roomScripts")
      .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
      .order("desc")
      .first();

    return {
      scenario: booking.scenario,
      minutes: booking.minutes,
      learnerLevel: booking.learnerLevel,
      targetLanguage: booking.targetLanguage,
      primaryLanguage: languages.primaryLanguage,
      words: targets.words.map((w) => ({ word: w.word, meaning: w.meaning })),
      latestVersion: latest?.version ?? 0,
    };
  },
});

export const saveScriptVersion = internalMutation({
  args: {
    bookingId: v.id("roomBookings"),
    lines: v.array(roomScriptLineValidator),
    generatedByLLM: v.boolean(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const latest = await ctx.db
      .query("roomScripts")
      .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
      .order("desc")
      .first();
    const version = (latest?.version ?? 0) + 1;
    await ctx.db.insert("roomScripts", {
      bookingId: args.bookingId,
      version,
      lines: args.lines,
      generatedByLLM: args.generatedByLLM,
      createdAt: Date.now(),
    });
    return version;
  },
});

const scriptLineInputValidator = v.object({ role: v.union(v.literal("learner"), v.literal("partner")), text: v.string() });
const MAX_EDIT_LINES = 30;
const MAX_LINE_TEXT = 300;

/** Free-form learner edit: saved as a new version, no LLM call. Word tracking is not re-validated after an edit. */
export const editScript = mutation({
  args: { bookingId: v.id("roomBookings"), lines: v.array(scriptLineInputValidator) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const booking = await ctx.db.get("roomBookings", args.bookingId);
    if (booking === null) notFound("Booking not found");
    if (booking.learnerId !== userId) forbidden("Only the learner who made this booking can edit its script");
    if (args.lines.length === 0 || args.lines.length > MAX_EDIT_LINES) invalid(`lines must have 1..${MAX_EDIT_LINES} entries`);
    for (const l of args.lines) {
      const text = l.text.trim();
      if (text.length === 0 || text.length > MAX_LINE_TEXT) invalid(`each line's text must be 1..${MAX_LINE_TEXT} characters`);
    }

    const latest = await ctx.db
      .query("roomScripts")
      .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
      .order("desc")
      .first();
    const version = (latest?.version ?? 0) + 1;
    await ctx.db.insert("roomScripts", {
      bookingId: args.bookingId,
      version,
      lines: args.lines.map((l) => ({ role: l.role, text: l.text.trim(), words: [] })),
      generatedByLLM: false,
      createdAt: Date.now(),
    });
    return version;
  },
});

export const latestScript = query({
  args: { bookingId: v.id("roomBookings") },
  returns: v.union(v.object({ version: v.number(), lines: v.array(roomScriptLineValidator), generatedByLLM: v.boolean() }), v.null()),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedBooking(ctx, args.bookingId, userId);
    const latest = await ctx.db
      .query("roomScripts")
      .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
      .order("desc")
      .first();
    if (latest === null) return null;
    return { version: latest.version, lines: latest.lines, generatedByLLM: latest.generatedByLLM };
  },
});

// ---------------------------------------------------------------------------
// Payment hooks (called from convex/payments.ts)
// ---------------------------------------------------------------------------

const bookingPricingValidator = v.object({
  mode: roomModeValidator,
  minutes: roomMinutesValidator,
  learnerId: v.id("users"),
  partnerId: v.union(v.id("users"), v.null()),
});

/** Server-trusted pricing inputs for payments.createOrder — the client-supplied amount is never used for room_booking. */
export const bookingPricingInfo = internalQuery({
  args: { bookingId: v.string() },
  returns: v.union(bookingPricingValidator, v.null()),
  handler: async (ctx, args) => {
    const booking = await ctx.db.get("roomBookings", args.bookingId as Id<"roomBookings">).catch(() => null);
    if (booking === null) return null;
    return { mode: booking.mode, minutes: booking.minutes, learnerId: booking.learnerId, partnerId: booking.partnerId ?? null };
  },
});

/** Called from payments.ts once a room_booking payment is authorized. Idempotent: only "matched" advances. */
export const markBookingConfirmed = internalMutation({
  args: { bookingId: v.string(), paymentId: v.id("payments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = args.bookingId as Id<"roomBookings">;
    const booking = await ctx.db.get("roomBookings", id);
    if (booking === null || booking.status !== "matched") return null;
    await ctx.db.patch("roomBookings", id, { status: "confirmed", paymentId: args.paymentId, updatedAt: Date.now() });

    const now = Date.now();
    if (booking.scheduledStartAt !== undefined) {
      const remindAt = booking.scheduledStartAt - REMINDER_BEFORE_START_MS;
      if (remindAt > now) await ctx.scheduler.runAt(remindAt, internal.rooms.sendReminder, { bookingId: id });
      // Floored at "now" so a payment that clears late (after start+grace already passed) still gives the
      // learner the full grace window to join from confirmation, instead of firing checkNoShow immediately.
      const noShowAt = Math.max(booking.scheduledStartAt + NO_SHOW_CHECK_AFTER_START_MS, now + NO_SHOW_CHECK_AFTER_START_MS);
      await ctx.scheduler.runAt(noShowAt, internal.rooms.checkNoShow, { bookingId: id });
    }
    if (booking.scheduledEndAt !== undefined) {
      // Task B: auto-end the live room at start+minutes(+1min grace) even if nobody calls completeSession.
      // Same late-confirmation floor as the no-show check above.
      const autoEndAt = Math.max(booking.scheduledEndAt + AUTO_END_GRACE_MS, now + AUTO_END_GRACE_MS);
      await ctx.scheduler.runAt(autoEndAt, internal.liveRoom.autoEndRoom, { bookingId: id });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Session lifecycle: join / no-show / complete / cancel
// ---------------------------------------------------------------------------

/** No real notification system yet — this is the integration point for one. */
export const sendReminder = internalMutation({
  args: { bookingId: v.id("roomBookings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const booking = await ctx.db.get("roomBookings", args.bookingId);
    if (booking === null || booking.status !== "confirmed") return null;
    console.log(`room reminder: booking ${args.bookingId} starts in ${REMINDER_BEFORE_START_MS / 60_000} minutes`);
    return null;
  },
});

/**
 * Records that `userId` actually joined the live room, flipping the booking
 * to "in_progress" once both have. Called only from liveRoom.joinRoom (the
 * action that also checks the join-time window and mints the LiveKit token) —
 * never exposed to the client directly.
 */
export const recordRoomJoin = internalMutation({
  args: { bookingId: v.id("roomBookings"), userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const booking = await requireOwnedBooking(ctx, args.bookingId, args.userId);
    if (booking.status !== "confirmed" && booking.status !== "in_progress") {
      invalid(`Cannot join a booking that is "${booking.status}"`);
    }
    const now = Date.now();
    const patch: Record<string, unknown> = { updatedAt: now };
    if (booking.learnerId === args.userId) patch.learnerJoinedAt = booking.learnerJoinedAt ?? now;
    if (booking.partnerId === args.userId) patch.partnerJoinedAt = booking.partnerJoinedAt ?? now;
    const learnerJoined = booking.learnerId === args.userId ? true : booking.learnerJoinedAt !== undefined;
    const partnerJoined = booking.partnerId === args.userId ? true : booking.partnerJoinedAt !== undefined;
    if (learnerJoined && partnerJoined) patch.status = "in_progress";
    await ctx.db.patch("roomBookings", args.bookingId, patch);
    return null;
  },
});

/**
 * Scheduled at start+5min. `learnerJoinedAt`/`partnerJoinedAt` (set by
 * recordRoomJoin) are the only real signal available — this sets a status, per
 * the task; it does not touch payment (Task C).
 */
export const checkNoShow = internalMutation({
  args: { bookingId: v.id("roomBookings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const booking = await ctx.db.get("roomBookings", args.bookingId);
    if (booking === null || booking.status !== "confirmed") return null; // already in_progress/completed/cancelled — nothing to do
    const learnerJoined = booking.learnerJoinedAt !== undefined;
    const partnerJoined = booking.partnerJoinedAt !== undefined;
    // Neither joined: default to no_show_partner (the paid service provider) — see convex/rooms.ts docstring / the build report.
    const status = learnerJoined && !partnerJoined ? "no_show_partner" : !learnerJoined && partnerJoined ? "no_show_learner" : "no_show_partner";
    await ctx.db.patch("roomBookings", args.bookingId, { status, updatedAt: Date.now() });
    if (status === "no_show_partner") {
      // The partner didn't show — void the authorization (or refund if somehow already captured); they are not paid.
      await ctx.scheduler.runAfter(0, internal.payments.refundOrVoidPayment, {
        purpose: "room_booking",
        refId: args.bookingId,
        reason: "partner no-show",
      });
    } else {
      // The learner didn't show, through no fault of the partner's — still capture, so the partner is still paid.
      await ctx.scheduler.runAfter(0, internal.payments.captureAuthorizedPayment, {
        purpose: "room_booking",
        refId: args.bookingId,
      });
    }
    return null;
  },
});

/** Either party marks the session done — capture (and pay the partner) is scheduled below. */
export const completeSession = mutation({
  args: { bookingId: v.id("roomBookings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const booking = await requireOwnedBooking(ctx, args.bookingId, userId);
    if (booking.status !== "in_progress") invalid(`Cannot complete a booking that is "${booking.status}"`);
    await ctx.db.patch("roomBookings", args.bookingId, { status: "completed", updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.payments.captureAuthorizedPayment, {
      purpose: "room_booking",
      refId: args.bookingId,
    });
    await ctx.scheduler.runAfter(0, internal.liveRoom.applyRoomEvidence, { bookingId: args.bookingId });
    return null;
  },
});

async function cancelBookingHandler(ctx: ActionCtx, args: { bookingId: Id<"roomBookings"> }): Promise<{ cancelled: boolean }> {
  const userId = await requireUserId(ctx);
  const info: { ownerOk: boolean; cancellable: boolean; hasPayment: boolean } = await ctx.runQuery(internal.rooms.cancellationInfo, {
    bookingId: args.bookingId,
    userId,
  });
  if (!info.ownerOk) forbidden("Only the learner who made this booking can cancel it");
  if (!info.cancellable) invalid("This booking can no longer be cancelled");

  if (info.hasPayment) {
    await ctx.runAction(internal.payments.refundOrVoidPayment, {
      purpose: "room_booking",
      refId: args.bookingId,
      reason: "learner cancelled",
    });
  }
  await ctx.runMutation(internal.rooms.applyCancellation, { bookingId: args.bookingId });
  return { cancelled: true };
}

/** Learner can cancel before the session starts. Voids/refunds the payment through the existing payments backend. */
export const cancelBooking = action({
  args: { bookingId: v.id("roomBookings") },
  returns: v.object({ cancelled: v.boolean() }),
  handler: cancelBookingHandler,
});

const cancellationInfoValidator = v.object({ ownerOk: v.boolean(), cancellable: v.boolean(), hasPayment: v.boolean() });

export const cancellationInfo = internalQuery({
  args: { bookingId: v.id("roomBookings"), userId: v.id("users") },
  returns: cancellationInfoValidator,
  handler: async (ctx, args) => {
    const booking = await ctx.db.get("roomBookings", args.bookingId);
    if (booking === null) return { ownerOk: false, cancellable: false, hasPayment: false };
    const ownerOk = booking.learnerId === args.userId;
    const cancellableStatus = booking.status === "requested" || booking.status === "matched" || booking.status === "confirmed";
    const notStarted = booking.scheduledStartAt === undefined || booking.scheduledStartAt > Date.now();
    return { ownerOk, cancellable: cancellableStatus && notStarted, hasPayment: booking.paymentId !== undefined };
  },
});

export const applyCancellation = internalMutation({
  args: { bookingId: v.id("roomBookings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const booking = await ctx.db.get("roomBookings", args.bookingId);
    if (booking === null) return null;
    if (booking.status === "cancelled") return null;
    await ctx.db.patch("roomBookings", args.bookingId, { status: "cancelled", updatedAt: Date.now() });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Display pricing (USD, for the "When" screen — never sent to Razorpay; see
// lib/rooms.ts's roomChargeInrPaise for the trusted INR charge amount).
// ---------------------------------------------------------------------------

const roomPriceItemValidator = v.object({
  mode: roomModeValidator,
  minutes: roomMinutesValidator,
  displayUsdCents: v.number(),
});

const ALL_MODES: readonly RoomMode[] = ["now", "later"];
const ALL_MINUTES: readonly RoomMinutes[] = [5, 10, 15];

export const roomPricing = query({
  args: {},
  returns: v.array(roomPriceItemValidator),
  handler: async (ctx) => {
    await requireUserId(ctx);
    const out: Array<typeof roomPriceItemValidator.type> = [];
    for (const mode of ALL_MODES) {
      for (const minutes of ALL_MINUTES) {
        out.push({ mode, minutes, displayUsdCents: roomDisplayUsdCents(mode, minutes) });
      }
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Queries for the mockup screens
// ---------------------------------------------------------------------------

const bookingSummaryValidator = v.object({
  _id: v.id("roomBookings"),
  targetLanguage: targetLanguageValidator,
  scenario: v.string(),
  minutes: roomMinutesValidator,
  mode: roomModeValidator,
  status: roomStatusValidator,
  partnerId: v.union(v.id("users"), v.null()),
  scheduledStartAt: v.union(v.number(), v.null()),
  scheduledEndAt: v.union(v.number(), v.null()),
});

function toBookingSummary(b: Doc<"roomBookings">): typeof bookingSummaryValidator.type {
  return {
    _id: b._id,
    targetLanguage: b.targetLanguage,
    scenario: b.scenario,
    minutes: b.minutes,
    mode: b.mode,
    status: b.status,
    partnerId: b.partnerId ?? null,
    scheduledStartAt: b.scheduledStartAt ?? null,
    scheduledEndAt: b.scheduledEndAt ?? null,
  };
}

const UPCOMING_STATUSES = ["requested", "matched", "confirmed", "in_progress"] as const;

/** The learner's upcoming sessions. */
export const roomsHome = query({
  args: {},
  returns: v.array(bookingSummaryValidator),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("roomBookings")
      .withIndex("by_learner", (q) => q.eq("learnerId", userId))
      .order("desc")
      .take(200);
    return rows
      .filter((b) => (UPCOMING_STATUSES as readonly string[]).includes(b.status))
      .sort((a, b) => (a.scheduledStartAt ?? 0) - (b.scheduledStartAt ?? 0))
      .map(toBookingSummary);
  },
});

const bookingDetailValidator = v.object({
  _id: v.id("roomBookings"),
  targetLanguage: targetLanguageValidator,
  scenario: v.string(),
  minutes: roomMinutesValidator,
  mode: roomModeValidator,
  status: roomStatusValidator,
  partnerId: v.union(v.id("users"), v.null()),
  scheduledStartAt: v.union(v.number(), v.null()),
  scheduledEndAt: v.union(v.number(), v.null()),
  learnerId: v.id("users"),
  learnerLevel: levelValidator,
  script: v.union(v.object({ version: v.number(), lines: v.array(roomScriptLineValidator) }), v.null()),
});

export const roomBookingDetail = query({
  args: { bookingId: v.id("roomBookings") },
  returns: bookingDetailValidator,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const booking = await requireOwnedBooking(ctx, args.bookingId, userId);
    const script = await ctx.db
      .query("roomScripts")
      .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
      .order("desc")
      .first();
    return {
      ...toBookingSummary(booking),
      learnerId: booking.learnerId,
      learnerLevel: booking.learnerLevel,
      script: script === null ? null : { version: script.version, lines: script.lines },
    };
  },
});

const partnerDashboardValidator = v.object({
  openNow: v.array(nowRequestValidator),
  booked: v.array(bookingSummaryValidator),
  earnings: v.object({ earnedCents: v.number(), heldCents: v.number(), paidCents: v.number() }),
});

/** requests now, booked sessions, and an earnings summary — one row per approved language the caller partners in. */
export const partnerDashboard = query({
  args: {},
  returns: partnerDashboardValidator,
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);

    const now = Date.now();
    const profiles = await ctx.db
      .query("partnerProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(10);
    // Same "actually available now" gate as openNowRequests — see that function's comment.
    const onlineApproved = profiles.filter(
      (p) => p.status === "approved" && p.level !== undefined && p.availableNow && partnerIsOnline(p.lastHeartbeatAt, now),
    );

    const openNow: Array<typeof nowRequestValidator.type> = [];
    for (const profile of onlineApproved) {
      const requests = await ctx.db
        .query("roomBookings")
        .withIndex("by_targetLanguage_and_mode_and_status", (q) =>
          q.eq("targetLanguage", profile.targetLanguage).eq("mode", "now").eq("status", "requested"),
        )
        .take(100);
      for (const r of requests) {
        if (r.matchDeadlineAt !== undefined && r.matchDeadlineAt <= now) continue;
        if (!partnerEligibleForLearner(profile.level as Level, r.learnerLevel)) continue;
        openNow.push({
          _id: r._id,
          scenario: r.scenario,
          targetLanguage: r.targetLanguage,
          learnerLevel: r.learnerLevel,
          minutes: r.minutes,
          matchDeadlineAt: r.matchDeadlineAt ?? now,
        });
      }
    }

    const bookedRows = await ctx.db
      .query("roomBookings")
      .withIndex("by_partner_and_status", (q) => q.eq("partnerId", userId))
      .take(500);
    const bookedStatuses: readonly string[] = ["matched", "confirmed", "in_progress", "completed"];
    const booked = bookedRows
      .filter((b) => bookedStatuses.includes(b.status))
      .sort((a, b) => (a.scheduledStartAt ?? 0) - (b.scheduledStartAt ?? 0))
      .map(toBookingSummary);

    const payouts = await ctx.db
      .query("partnerPayouts")
      .withIndex("by_partner", (q) => q.eq("partnerId", String(userId)))
      .take(500);
    const sum = (status: "earned" | "held" | "paid") => payouts.filter((p) => p.status === status).reduce((acc, p) => acc + p.amount, 0);

    return {
      openNow,
      booked,
      earnings: { earnedCents: sum("earned"), heldCents: sum("held"), paidCents: sum("paid") },
    };
  },
});

// ---------------------------------------------------------------------------
// Partner earnings history (screen 4) — one row per finished session, joined
// against its payout ledger entry when one exists. A session with no payout
// row (payment never captured — a no-show, or capture not yet run) shows
// `payoutStatus: null`; the UI reads that as "not paid".
// ---------------------------------------------------------------------------

const TERMINAL_BOOKING_STATUSES: readonly string[] = [
  "completed",
  "no_show_partner",
  "no_show_learner",
  "ended_violation",
  "cancelled",
];

const partnerHistoryItemValidator = v.object({
  _id: v.id("roomBookings"),
  scenario: v.string(),
  minutes: roomMinutesValidator,
  scheduledStartAt: v.union(v.number(), v.null()),
  status: roomStatusValidator,
  payoutStatus: v.union(payoutStatusValidator, v.null()),
  earningInrPaise: v.number(),
  earningUsdCents: v.number(),
});

/** The caller's own finished sessions (as a partner) with each one's payout status, most recent first. */
export const partnerSessionHistory = query({
  args: {},
  returns: v.array(partnerHistoryItemValidator),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("roomBookings")
      .withIndex("by_partner_and_status", (q) => q.eq("partnerId", userId))
      .take(500);
    const finished = rows.filter((b) => TERMINAL_BOOKING_STATUSES.includes(b.status));

    const out: Array<typeof partnerHistoryItemValidator.type> = [];
    for (const b of finished) {
      const payout =
        b.paymentId !== undefined
          ? await ctx.db
              .query("partnerPayouts")
              .withIndex("by_payment", (q) => q.eq("paymentId", b.paymentId!))
              .first()
          : null;
      out.push({
        _id: b._id,
        scenario: b.scenario,
        minutes: b.minutes,
        scheduledStartAt: b.scheduledStartAt ?? null,
        status: b.status,
        payoutStatus: payout?.status ?? null,
        earningInrPaise: partnerEarning(b.minutes).earningInrPaise,
        earningUsdCents: partnerEarning(b.minutes).earningUsdCents,
      });
    }
    out.sort((a, b) => (b.scheduledStartAt ?? 0) - (a.scheduledStartAt ?? 0));
    return out;
  },
});
