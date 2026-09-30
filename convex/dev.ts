/**
 * Development-only maintenance functions.
 *
 * Everything here is `internalMutation` / `internalQuery`, so none of it is
 * reachable from a client. The seed script invokes `devReset` through the
 * Convex CLI (`convex run`), which authenticates with the deploy key.
 *
 * `devReset` is destructive and exists solely to support the seed script's
 * `--fresh` flag. It wipes one account's LEARNING STATE; it never deletes the
 * account itself, so sign-in stays stable across resets.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { levelValidator, roomMinutesValidator, roomScriptLineValidator, targetLanguageValidator } from "./schema";

const MAX_ROWS = 500;

const resetCountsValidator = v.object({
  goals: v.number(),
  goalTargets: v.number(),
  levelChecks: v.number(),
  attempts: v.number(),
  levelResults: v.number(),
  plans: v.number(),
  purchases: v.number(),
});

/**
 * Deletes every piece of learning state belonging to `email`.
 * Returns row counts so the caller can report what was cleared.
 */
export const devReset = internalMutation({
  args: { email: v.string() },
  returns: v.object({
    found: v.boolean(),
    userId: v.union(v.id("users"), v.null()),
    deleted: resetCountsValidator,
  }),
  handler: async (ctx, args) => {
    const deleted = {
      goals: 0,
      goalTargets: 0,
      levelChecks: 0,
      attempts: 0,
      levelResults: 0,
      plans: 0,
      purchases: 0,
    };

    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email))
      .first();
    if (user === null) {
      return { found: false, userId: null, deleted };
    }
    const userId: Id<"users"> = user._id;

    // Purchases -> plans -> levelResults -> attempts -> levelChecks ->
    // goalTargets -> goals. Children before parents.
    const purchases = await ctx.db
      .query("purchases")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_ROWS);
    for (const row of purchases) {
      await ctx.db.delete("purchases", row._id);
      deleted.purchases++;
    }

    const plans = await ctx.db
      .query("plans")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_ROWS);
    for (const row of plans) {
      await ctx.db.delete("plans", row._id);
      deleted.plans++;
    }

    const levelResults = await ctx.db
      .query("levelResults")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_ROWS);
    for (const row of levelResults) {
      await ctx.db.delete("levelResults", row._id);
      deleted.levelResults++;
    }

    const levelChecks = await ctx.db
      .query("levelChecks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_ROWS);
    for (const check of levelChecks) {
      const attempts = await ctx.db
        .query("attempts")
        .withIndex("by_level_check", (q) => q.eq("levelCheckId", check._id))
        .take(MAX_ROWS);
      for (const attempt of attempts) {
        await ctx.db.delete("attempts", attempt._id);
        deleted.attempts++;
      }
      await ctx.db.delete("levelChecks", check._id);
      deleted.levelChecks++;
    }

    const goals = await ctx.db
      .query("goals")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_ROWS);
    for (const goal of goals) {
      const targets = await ctx.db
        .query("goalTargets")
        .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
        .take(MAX_ROWS);
      for (const target of targets) {
        await ctx.db.delete("goalTargets", target._id);
        deleted.goalTargets++;
      }
      await ctx.db.delete("goals", goal._id);
      deleted.goals++;
    }

    return { found: true, userId, deleted };
  },
});

/**
 * Deletes every level check of `email` (with its attempts and result) EXCEPT
 * `keepLevelCheckId`. For cleaning up after UI test runs that took extra level
 * checks; goals, targets, plans and the kept check are left alone.
 */
export const removeOtherLevelChecks = internalMutation({
  args: { email: v.string(), keepLevelCheckId: v.id("levelChecks") },
  returns: v.object({ levelChecks: v.number(), attempts: v.number(), levelResults: v.number() }),
  handler: async (ctx, args) => {
    const removed = { levelChecks: 0, attempts: 0, levelResults: 0 };
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email))
      .first();
    if (user === null) return removed;
    const keep = await ctx.db.get("levelChecks", args.keepLevelCheckId);
    if (keep === null || keep.userId !== user._id) {
      throw new Error("keepLevelCheckId must be an existing level check of this user");
    }

    const checks = await ctx.db
      .query("levelChecks")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(MAX_ROWS);
    for (const check of checks) {
      if (check._id === keep._id) continue;
      const attempts = await ctx.db
        .query("attempts")
        .withIndex("by_level_check", (q) => q.eq("levelCheckId", check._id))
        .take(MAX_ROWS);
      for (const attempt of attempts) {
        await ctx.db.delete("attempts", attempt._id);
        removed.attempts++;
      }
      const results = await ctx.db
        .query("levelResults")
        .withIndex("by_level_check", (q) => q.eq("levelCheckId", check._id))
        .take(MAX_ROWS);
      for (const result of results) {
        await ctx.db.delete("levelResults", result._id);
        removed.levelResults++;
      }
      await ctx.db.delete("levelChecks", check._id);
      removed.levelChecks++;
    }
    return removed;
  },
});

/** Deletes every saved word of `email` (Home test cleanup). Returns how many were removed. */
export const clearSavedWords = internalMutation({
  args: { email: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email))
      .first();
    if (user === null) return 0;
    const rows = await ctx.db
      .query("savedWords")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(MAX_ROWS);
    for (const row of rows) await ctx.db.delete("savedWords", row._id);
    return rows.length;
  },
});

/** Deletes one goal's plan (and its status row, if any) so generation can be re-tested from scratch. */
export const deletePlanForGoal = internalMutation({
  args: { goalId: v.id("goals") },
  returns: v.object({ deletedPlan: v.boolean(), deletedStatus: v.boolean() }),
  handler: async (ctx, args) => {
    const plan = await ctx.db
      .query("plans")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();
    if (plan !== null) await ctx.db.delete("plans", plan._id);
    const status = await ctx.db
      .query("planStatus")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();
    if (status !== null) await ctx.db.delete("planStatus", status._id);
    return { deletedPlan: plan !== null, deletedStatus: status !== null };
  },
});

/** Test-only: force a level result's level, to exercise level-gated code paths (e.g. labs.generateLabForDay's starting/basic gate). */
export const setLevelResultLevel = internalMutation({
  args: { levelResultId: v.id("levelResults"), level: v.union(v.literal("starting"), v.literal("basic"), v.literal("intermediate"), v.literal("confident")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("levelResults", args.levelResultId, { level: args.level });
    return null;
  },
});

/** Deletes every lab (and its progress rows) for one goal — cleans up after lab test runs. */
export const clearLabsForGoal = internalMutation({
  args: { goalId: v.id("goals") },
  returns: v.object({ labs: v.number(), wordProgress: v.number(), patternProgress: v.number() }),
  handler: async (ctx, args) => {
    const removed = { labs: 0, wordProgress: 0, patternProgress: 0 };
    const labs = await ctx.db
      .query("labs")
      .withIndex("by_goal_and_day", (q) => q.eq("goalId", args.goalId))
      .take(MAX_ROWS);
    for (const row of labs) {
      await ctx.db.delete("labs", row._id);
      removed.labs++;
    }
    const words = await ctx.db
      .query("wordProgress")
      .withIndex("by_goal_and_normalized", (q) => q.eq("goalId", args.goalId))
      .take(MAX_ROWS);
    for (const row of words) {
      await ctx.db.delete("wordProgress", row._id);
      removed.wordProgress++;
    }
    const patterns = await ctx.db
      .query("patternProgress")
      .withIndex("by_goal_and_normalized", (q) => q.eq("goalId", args.goalId))
      .take(MAX_ROWS);
    for (const row of patterns) {
      await ctx.db.delete("patternProgress", row._id);
      removed.patternProgress++;
    }
    return removed;
  },
});

/**
 * Test-only: gives a user an active goal + a "done" level result at a chosen
 * level, WITHOUT running the real (expensive, LLM-scored) level check flow.
 * rooms.requestRoomNow/requestRoomLater only need `loadActiveGoal` + a
 * levelResult to exist — no goalTargets — so this is enough to exercise
 * room-request/matching/booking logic in tests.
 */
export const seedRoomLearner = internalMutation({
  args: { userId: v.id("users"), level: levelValidator },
  returns: v.object({ goalId: v.id("goals") }),
  handler: async (ctx, args) => {
    const activeGoals = await ctx.db
      .query("goals")
      .withIndex("by_user_and_active", (q) => q.eq("userId", args.userId).eq("active", true))
      .take(MAX_ROWS);
    for (const g of activeGoals) await ctx.db.patch("goals", g._id, { active: false });

    const now = Date.now();
    const goalId = await ctx.db.insert("goals", {
      userId: args.userId,
      goalType: "custom",
      goalText: "Rooms test goal",
      deadline: "none",
      minutesPerDay: 15,
      active: true,
      createdAt: now,
    });
    const levelCheckId = await ctx.db.insert("levelChecks", {
      userId: args.userId,
      goalId,
      status: "done",
      createdAt: now,
      finishedAt: now,
    });
    await ctx.db.insert("levelResults", {
      levelCheckId,
      userId: args.userId,
      goalId,
      canUse: [],
      practising: [],
      notYet: [],
      grammar: [],
      speakingSummary: "seeded for rooms testing",
      level: args.level,
      knownCount: 0,
      totalCount: 0,
      createdAt: now,
    });
    return { goalId };
  },
});

/** Test-only: force-approves a partner profile at a chosen level, bypassing the real speaking test. Idempotent (upserts). */
export const seedPartnerProfile = internalMutation({
  args: {
    userId: v.id("users"),
    targetLanguage: targetLanguageValidator,
    level: levelValidator,
    availableNow: v.optional(v.boolean()),
  },
  returns: v.id("partnerProfiles"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("partnerProfiles")
      .withIndex("by_user_and_language", (q) => q.eq("userId", args.userId).eq("targetLanguage", args.targetLanguage))
      .first();
    const availableNow = args.availableNow ?? false;
    if (existing !== null) {
      await ctx.db.patch("partnerProfiles", existing._id, {
        status: "approved",
        level: args.level,
        availableNow,
        ...(availableNow ? { lastHeartbeatAt: now } : {}),
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("partnerProfiles", {
      userId: args.userId,
      targetLanguage: args.targetLanguage,
      status: "approved",
      level: args.level,
      availableNow,
      ...(availableNow ? { lastHeartbeatAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Test-only cleanup for the rooms concurrency tests: removes bookings + a slot's availability for one partner profile. */
export const clearRoomTestData = internalMutation({
  args: { partnerProfileId: v.id("partnerProfiles") },
  returns: v.object({ bookings: v.number(), availability: v.number() }),
  handler: async (ctx, args) => {
    const profile = await ctx.db.get("partnerProfiles", args.partnerProfileId);
    const removed = { bookings: 0, availability: 0 };
    if (profile !== null) {
      const bookings = await ctx.db
        .query("roomBookings")
        .withIndex("by_partner_and_status", (q) => q.eq("partnerId", profile.userId))
        .take(MAX_ROWS);
      for (const b of bookings) {
        await ctx.db.delete("roomBookings", b._id);
        removed.bookings++;
      }
    }
    const availability = await ctx.db
      .query("partnerAvailability")
      .withIndex("by_partnerProfile", (q) => q.eq("partnerProfileId", args.partnerProfileId))
      .take(MAX_ROWS);
    for (const a of availability) {
      await ctx.db.delete("partnerAvailability", a._id);
      removed.availability++;
    }
    return removed;
  },
});

/** Test-only: removes every "now" roomBooking a learner created (so re-running requestRoomNow tests is idempotent). */
export const clearLearnerRoomBookings = internalMutation({
  args: { userId: v.id("users") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const bookings = await ctx.db
      .query("roomBookings")
      .withIndex("by_learner", (q) => q.eq("learnerId", args.userId))
      .take(MAX_ROWS);
    for (const b of bookings) await ctx.db.delete("roomBookings", b._id);
    return bookings.length;
  },
});

/**
 * Test-only: forces a room booking straight to "confirmed" with a fresh
 * schedule, bypassing the real Razorpay payment flow entirely (verify.ts and
 * scripts/e2e.ts have no way to complete a real payment). Also clears any
 * prior live-room state (joins, strikes, script progress, stuck cue) so the
 * live-room flow can be re-tested from a clean slate on a re-run.
 */
export const confirmRoomBookingForTest = internalMutation({
  args: { bookingId: v.id("roomBookings"), startInMs: v.number(), minutes: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const scheduledStartAt = now + args.startInMs;
    const scheduledEndAt = scheduledStartAt + args.minutes * 60_000;
    await ctx.db.patch("roomBookings", args.bookingId, {
      status: "confirmed",
      scheduledStartAt,
      scheduledEndAt,
      learnerJoinedAt: undefined,
      partnerJoinedAt: undefined,
      nextLearnerLineIndex: undefined,
      doneLineIndices: undefined,
      stuckCue: undefined,
      stuckCount: undefined,
      learnerStrikes: undefined,
      partnerStrikes: undefined,
      lastWarning: undefined,
      violatorRole: undefined,
      updatedAt: now,
    });
    return null;
  },
});

/** Test-only: removes every roomTurn + roomReport for one booking, so the live-room flow can be re-run cleanly. */
export const clearRoomTurns = internalMutation({
  args: { bookingId: v.id("roomBookings") },
  returns: v.object({ turns: v.number(), reports: v.number() }),
  handler: async (ctx, args) => {
    const turns = await ctx.db
      .query("roomTurns")
      .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
      .take(MAX_ROWS);
    for (const t of turns) await ctx.db.delete("roomTurns", t._id);
    const reports = await ctx.db
      .query("roomReports")
      .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
      .take(MAX_ROWS);
    for (const r of reports) await ctx.db.delete("roomReports", r._id);
    return { turns: turns.length, reports: reports.length };
  },
});

/**
 * Test-only: creates a room booking directly in "confirmed" status between an
 * already-approved partner and a learner, bypassing matching AND payment
 * entirely (verify.ts's fixed accounts already exercise matching/payment
 * elsewhere — this is only for exercising the LIVE room: join, streaming,
 * script tracking, safety).
 */
export const seedRoomBookingForTest = internalMutation({
  args: {
    learnerId: v.id("users"),
    partnerId: v.id("users"),
    partnerProfileId: v.id("partnerProfiles"),
    targetLanguage: targetLanguageValidator,
    learnerLevel: levelValidator,
    minutes: roomMinutesValidator,
    /** Milliseconds from now (may be negative to place the start in the past). */
    startInMs: v.number(),
  },
  returns: v.id("roomBookings"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const scheduledStartAt = now + args.startInMs;
    const scheduledEndAt = scheduledStartAt + args.minutes * 60_000;
    return await ctx.db.insert("roomBookings", {
      learnerId: args.learnerId,
      targetLanguage: args.targetLanguage,
      learnerLevel: args.learnerLevel,
      scenario: "live room test",
      minutes: args.minutes,
      mode: "later",
      status: "confirmed",
      partnerId: args.partnerId,
      partnerProfileId: args.partnerProfileId,
      scheduledStartAt,
      scheduledEndAt,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Test-only: replaces a booking's script with fixed, known lines — no LLM call, deterministic for line-matching tests. */
export const seedRoomScript = internalMutation({
  args: { bookingId: v.id("roomBookings"), lines: v.array(roomScriptLineValidator) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("roomScripts")
      .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
      .take(MAX_ROWS);
    for (const row of existing) await ctx.db.delete("roomScripts", row._id);
    const version = 1;
    await ctx.db.insert("roomScripts", { bookingId: args.bookingId, version, lines: args.lines, generatedByLLM: false, createdAt: Date.now() });
    return version;
  },
});

/**
 * Test-only: the word list of one goal's targets. No public API exposes a
 * non-active goal's full vocabulary (a partner test taker should not see the
 * "answer key" up front) — scripts/e2e.ts uses this only to build a fabricated
 * speaking-test transcript with enough goal-word coverage to score above the
 * partner-approval bar, deterministically, without guessing at word counts.
 */
export const goalVocabulary = internalQuery({
  args: { goalId: v.id("goals") },
  returns: v.object({ words: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();
    return { words: targets === null ? [] : targets.words.map((w) => w.word) };
  },
});
