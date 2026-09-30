/**
 * Partner role: apply to be a speaking partner for one target language,
 * take the speaking test, set weekly availability, and toggle "available
 * now" with a heartbeat.
 *
 * The test REUSES the level check flow exactly (goals.ts / levelCheck.ts /
 * scoring.ts, unchanged) against a dedicated `goalType: "partner_test"` goal
 * that is never `active` — it never becomes the caller's learner Home
 * screen, and it is independent of whatever the caller is personally
 * learning (`targetLanguageOverride`, see goals.goalContext). A client takes
 * the test the normal way: `levelCheck.startLevelCheck({ goalId: testGoalId })`,
 * then `levelCheck.getStreamConfig({ purpose, goalId: testGoalId })`,
 * `saveAttempt`, `finishLevelCheck` — nothing new to learn there. Once
 * scoring finishes, `scoring.ts` calls `applyTestResult` below instead of
 * scheduling a learning plan (a partner_test goal needs no plan).
 */

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { levelCheckPromptValidator, levelValidator, partnerStatusValidator, targetLanguageValidator } from "./schema";
import { forbidden, invalid, notFound, requireOwnedGoal, requireUserId } from "./lib/authz";
import { readLanguageProfile } from "./lib/languages";
import { partnerApproved, partnerIsOnline } from "./lib/rooms";

const MAX_AVAILABILITY_SLOTS = 50;

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const applyResultValidator = v.object({
  partnerProfileId: v.id("partnerProfiles"),
  testGoalId: v.id("goals"),
});

/** Applies (or, after a rejection, re-applies) to be a partner for one target language, and starts a fresh speaking test. */
export const applyAsPartner = mutation({
  args: { targetLanguage: targetLanguageValidator },
  returns: applyResultValidator,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const user = await ctx.db.get("users", userId);
    if (user === null || readLanguageProfile(user) === null) {
      invalid("Choose your languages first: call users.updateProfile before applying as a partner.");
    }

    const existing = await ctx.db
      .query("partnerProfiles")
      .withIndex("by_user_and_language", (q) => q.eq("userId", userId).eq("targetLanguage", args.targetLanguage))
      .first();
    // Pending/approved: idempotent, return the same in-flight or active application.
    if (existing !== null && existing.status !== "rejected" && existing.testGoalId !== undefined) {
      return { partnerProfileId: existing._id, testGoalId: existing.testGoalId };
    }

    const now = Date.now();
    const testGoalId = await ctx.db.insert("goals", {
      userId,
      goalType: "partner_test",
      goalText: "Partner speaking test",
      deadline: "none",
      minutesPerDay: 15,
      active: false,
      targetLanguageOverride: args.targetLanguage,
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.goals.generateGoalTargets, { goalId: testGoalId, userId });

    if (existing !== null) {
      await ctx.db.patch("partnerProfiles", existing._id, {
        status: "pending",
        level: undefined,
        testGoalId,
        updatedAt: now,
      });
      return { partnerProfileId: existing._id, testGoalId };
    }
    const partnerProfileId = await ctx.db.insert("partnerProfiles", {
      userId,
      targetLanguage: args.targetLanguage,
      status: "pending",
      testGoalId,
      availableNow: false,
      createdAt: now,
      updatedAt: now,
    });
    return { partnerProfileId, testGoalId };
  },
});

/** Called by scoring.ts once a partner_test goal's level check scores — never by a client. */
export const applyTestResult = internalMutation({
  args: { goalId: v.id("goals"), level: levelValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("partnerProfiles")
      .withIndex("by_testGoalId", (q) => q.eq("testGoalId", args.goalId))
      .first();
    if (profile === null) return null; // not a partner test goal (or the profile was since removed) — nothing to do
    await ctx.db.patch("partnerProfiles", profile._id, {
      level: args.level,
      status: partnerApproved(args.level) ? "approved" : "rejected",
      updatedAt: Date.now(),
    });
    return null;
  },
});

const testGoalStatusValidator = v.object({
  targetLanguage: targetLanguageValidator,
  targetsReady: v.boolean(),
  levelCheckWords: v.array(v.string()),
  levelCheckPrompts: v.array(levelCheckPromptValidator),
});

/**
 * The partner_test goal's readiness + level-check material — the seam a
 * partner's speaking test UI needs to show words/prompts (same shape as
 * goals.activeGoal's targets) for a goal that is never the caller's active
 * one. Refuses anything but the caller's own partner_test goal.
 */
export const testGoalStatus = query({
  args: { goalId: v.id("goals") },
  returns: testGoalStatusValidator,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const goal = await requireOwnedGoal(ctx, args.goalId, userId);
    if (goal.goalType !== "partner_test") forbidden("Not a partner test goal");
    const targetLanguage = goal.targetLanguageOverride;
    if (targetLanguage === undefined) throw new Error(`partner_test goal ${goal._id} is missing targetLanguageOverride`);

    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();
    return {
      targetLanguage,
      targetsReady: targets !== null,
      levelCheckWords: targets?.levelCheckWords ?? [],
      levelCheckPrompts: targets?.levelCheckPrompts ?? [],
    };
  },
});

// ---------------------------------------------------------------------------
// Profile / availability / heartbeat
// ---------------------------------------------------------------------------

const partnerProfileValidator = v.object({
  _id: v.id("partnerProfiles"),
  targetLanguage: targetLanguageValidator,
  status: partnerStatusValidator,
  level: v.union(levelValidator, v.null()),
  testGoalId: v.union(v.id("goals"), v.null()),
  availableNow: v.boolean(),
  online: v.boolean(),
});

function toProfileView(row: Doc<"partnerProfiles">, now: number): typeof partnerProfileValidator.type {
  return {
    _id: row._id,
    targetLanguage: row.targetLanguage,
    status: row.status,
    level: row.level ?? null,
    testGoalId: row.testGoalId ?? null,
    availableNow: row.availableNow,
    online: partnerIsOnline(row.lastHeartbeatAt, now),
  };
}

/** All of the caller's partner profiles (one per target language they've applied for). */
export const myPartnerProfiles = query({
  args: {},
  returns: v.array(partnerProfileValidator),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const now = Date.now();
    const rows = await ctx.db
      .query("partnerProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(10);
    return rows.map((r) => toProfileView(r, now));
  },
});

async function requireOwnedProfile(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  targetLanguage: "en" | "de",
): Promise<Doc<"partnerProfiles">> {
  const profile = await ctx.db
    .query("partnerProfiles")
    .withIndex("by_user_and_language", (q) => q.eq("userId", userId).eq("targetLanguage", targetLanguage))
    .first();
  if (profile === null) notFound("No partner profile for this target language — call applyAsPartner first");
  if (profile.userId !== userId) forbidden("This partner profile belongs to another user");
  return profile;
}

export const setAvailableNow = mutation({
  args: { targetLanguage: targetLanguageValidator, available: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const profile = await requireOwnedProfile(ctx, userId, args.targetLanguage);
    const now = Date.now();
    await ctx.db.patch("partnerProfiles", profile._id, {
      availableNow: args.available,
      ...(args.available ? { lastHeartbeatAt: now } : {}),
      updatedAt: now,
    });
    return null;
  },
});

/** The client calls this every <2 minutes while `availableNow` is true — see HEARTBEAT_TIMEOUT_MS. */
export const heartbeat = mutation({
  args: { targetLanguage: targetLanguageValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const profile = await requireOwnedProfile(ctx, userId, args.targetLanguage);
    await ctx.db.patch("partnerProfiles", profile._id, { lastHeartbeatAt: Date.now(), updatedAt: Date.now() });
    return null;
  },
});

const availabilitySlotValidator = v.object({
  dayOfWeek: v.number(),
  startMinute: v.number(),
  endMinute: v.number(),
  timezone: v.string(),
});

/** Replace-all: the caller's full weekly schedule for this language becomes exactly `slots`. */
export const setWeeklyAvailability = mutation({
  args: { targetLanguage: targetLanguageValidator, slots: v.array(availabilitySlotValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const profile = await requireOwnedProfile(ctx, userId, args.targetLanguage);
    if (args.slots.length > MAX_AVAILABILITY_SLOTS) invalid(`at most ${MAX_AVAILABILITY_SLOTS} slots`);
    for (const s of args.slots) {
      if (!Number.isInteger(s.dayOfWeek) || s.dayOfWeek < 0 || s.dayOfWeek > 6) invalid("dayOfWeek must be an integer 0..6");
      if (!Number.isInteger(s.startMinute) || s.startMinute < 0 || s.startMinute >= 1440) {
        invalid("startMinute must be an integer 0..1439");
      }
      if (!Number.isInteger(s.endMinute) || s.endMinute <= s.startMinute || s.endMinute > 1440) {
        invalid("endMinute must be an integer greater than startMinute and at most 1440");
      }
      if (s.timezone.trim().length === 0) invalid("timezone is required");
    }

    const existing = await ctx.db
      .query("partnerAvailability")
      .withIndex("by_partnerProfile", (q) => q.eq("partnerProfileId", profile._id))
      .take(MAX_AVAILABILITY_SLOTS);
    for (const row of existing) await ctx.db.delete("partnerAvailability", row._id);
    for (const s of args.slots) {
      await ctx.db.insert("partnerAvailability", {
        partnerProfileId: profile._id,
        dayOfWeek: s.dayOfWeek,
        startMinute: s.startMinute,
        endMinute: s.endMinute,
        timezone: s.timezone,
        createdAt: Date.now(),
      });
    }
    return null;
  },
});

export const myWeeklyAvailability = query({
  args: { targetLanguage: targetLanguageValidator },
  returns: v.array(availabilitySlotValidator),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const profile = await requireOwnedProfile(ctx, userId, args.targetLanguage);
    const rows = await ctx.db
      .query("partnerAvailability")
      .withIndex("by_partnerProfile", (q) => q.eq("partnerProfileId", profile._id))
      .take(MAX_AVAILABILITY_SLOTS);
    return rows.map((r) => ({ dayOfWeek: r.dayOfWeek, startMinute: r.startMinute, endMinute: r.endMinute, timezone: r.timezone }));
  },
});
