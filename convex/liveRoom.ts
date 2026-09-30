/**
 * The live room: joining (LiveKit), per-participant AssemblyAI streaming
 * config, deterministic script-line tracking, stuck-silence detection,
 * two-tier safety (fast rule check + LLM Gateway for the borderline tier),
 * and recording upload. Booking lifecycle (request/match/confirm/cancel) is
 * convex/rooms.ts; this file only concerns the LIVE session once a booking
 * is "confirmed".
 *
 * Function ordering in this file matters: every internalQuery/internalMutation
 * that a same-file action/mutation calls via `ctx.runQuery`/`ctx.runMutation`/
 * `ctx.scheduler.runAfter(internal.liveRoom.X, ...)` is declared BEFORE that
 * caller, and every such caller's handler is a separately-declared, explicitly
 * typed function (not an inline arrow) — see convex/labs.ts / convex/payments.ts
 * for why: `internal.liveRoom` is typed via `typeof liveRoom` (this whole
 * module), so an unannotated same-file caller creates a real circular type.
 */

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  roomReportValidator,
  roomSafetyFlagValidator,
  roomScriptRoleValidator,
  roomStatusValidator,
  roomTargetWordSaidValidator,
  roomWarningValidator,
  targetLanguageValidator,
  transcriptWordValidator,
} from "./schema";
import { forbidden, invalid, loadActiveGoal, requireUserId } from "./lib/authz";
import { requireOwnedBooking } from "./rooms";
import { currentWordStatus, writeWordStatus } from "./labs";
import { nextWordStatus, todayKey } from "./lib/labValidate";
import {
  JOIN_WINDOW_BEFORE_START_MS,
  ROOM_REPORT_JSON_SCHEMA,
  ROOM_REPORT_SYSTEM,
  STUCK_SILENCE_MS,
  computeRoomReportStats,
  extractKeyterms,
  nextLearnerLineIndex,
  roomReportPrompt,
  scriptLineMatches,
  tokenTtlSeconds,
  validateRoomReportFeedback,
  withinJoinWindow,
  type ReportTurnLike,
} from "./lib/liveRoom";
import { mintRoomToken, type RoomRole } from "./lib/livekitToken";
import { createStreamingToken } from "./lib/assemblyai";
import { LANGUAGE_NAMES, STREAM_MODEL_TARGET, type KnownLanguage } from "./lib/languages";
import {
  SAFETY_JSON_SCHEMA,
  SAFETY_SYSTEM_PROMPT,
  ruleCheckAnyLanguage,
  safetyUserPrompt,
  validateSafetyVerdict,
  type SafetyVerdict,
} from "./lib/safety";
import { confidenceFor, containsPhrase } from "./scoring";
import { llmJson } from "./lib/llm";
import { llmRecorder } from "./llmMetrics";

const MAX_TRANSCRIPT_CHARS = 2_000;
const MAX_TURN_WORDS = 200;
const MAX_REPORT_REASON_CHARS = 500;
/** AssemblyAI's own bound is 60..10800s; a room is at most 15 minutes, so this is generous headroom. */
const STREAM_MAX_SESSION_SECONDS = 1_800;

type RawTurnWord = { text: string; confidence: number; start: number; end: number };

function sanitizeTurnWords(raw: RawTurnWord[]): RawTurnWord[] {
  if (raw.length > MAX_TURN_WORDS) invalid(`words must contain at most ${MAX_TURN_WORDS} entries`);
  return raw.map((word, i) => {
    if (!Number.isFinite(word.confidence)) invalid(`words[${i}].confidence must be a finite number`);
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end)) {
      invalid(`words[${i}].start and words[${i}].end must be finite numbers`);
    }
    return {
      text: word.text.slice(0, 200),
      confidence: Math.min(1, Math.max(0, word.confidence)),
      start: Math.max(0, word.start),
      end: Math.max(0, word.end),
    };
  });
}

/** Shared by the immediate rule-violation path and the deferred LLM-confirmed path. Idempotent against a room that already ended some other way. */
async function applyStrike(
  ctx: MutationCtx,
  bookingId: Id<"roomBookings">,
  role: RoomRole,
  reason: string,
): Promise<void> {
  const booking = await ctx.db.get("roomBookings", bookingId);
  if (booking === null || booking.status !== "in_progress") return;
  const current = (role === "learner" ? booking.learnerStrikes : booking.partnerStrikes) ?? 0;
  const next = current + 1;
  const now = Date.now();
  const strikeField = role === "learner" ? "learnerStrikes" : "partnerStrikes";
  if (next >= 2) {
    await ctx.db.patch("roomBookings", bookingId, {
      [strikeField]: next,
      status: "ended_violation",
      violatorRole: role,
      updatedAt: now,
    });
    if (role === "partner") {
      // The partner violated the rules — void the authorization; they are not paid.
      await ctx.scheduler.runAfter(0, internal.payments.refundOrVoidPayment, {
        purpose: "room_booking",
        refId: bookingId,
        reason: "partner violation",
      });
    } else {
      // The learner violated the rules, through no fault of the partner's — still capture, so the partner is still paid.
      await ctx.scheduler.runAfter(0, internal.payments.captureAuthorizedPayment, {
        purpose: "room_booking",
        refId: bookingId,
      });
    }
  } else {
    await ctx.db.patch("roomBookings", bookingId, {
      [strikeField]: next,
      lastWarning: { role, reason, at: now },
      updatedAt: now,
    });
  }
}

// ---------------------------------------------------------------------------
// Internal reads used by more than one action/mutation below (declared first
// — see file-header note on ordering).
// ---------------------------------------------------------------------------

const joinContextValidator = v.object({
  role: roomScriptRoleValidator,
  status: roomStatusValidator,
  scheduledStartAt: v.union(v.number(), v.null()),
  scheduledEndAt: v.union(v.number(), v.null()),
});

export const joinContext = internalQuery({
  args: { bookingId: v.id("roomBookings"), userId: v.id("users") },
  returns: joinContextValidator,
  handler: async (ctx, args) => {
    const booking = await requireOwnedBooking(ctx, args.bookingId, args.userId);
    const role: RoomRole = booking.learnerId === args.userId ? "learner" : "partner";
    return {
      role,
      status: booking.status,
      scheduledStartAt: booking.scheduledStartAt ?? null,
      scheduledEndAt: booking.scheduledEndAt ?? null,
    };
  },
});

const turnSafetyContextValidator = v.object({
  bookingId: v.id("roomBookings"),
  role: roomScriptRoleValidator,
  transcript: v.string(),
  language: targetLanguageValidator,
  bookingStatus: roomStatusValidator,
});

export const turnSafetyContext = internalQuery({
  args: { turnId: v.id("roomTurns") },
  returns: v.union(turnSafetyContextValidator, v.null()),
  handler: async (ctx, args) => {
    const turn = await ctx.db.get("roomTurns", args.turnId);
    if (turn === null) return null;
    const booking = await ctx.db.get("roomBookings", turn.bookingId);
    if (booking === null) return null;
    return {
      bookingId: turn.bookingId,
      role: turn.role,
      transcript: turn.transcript,
      language: booking.targetLanguage,
      bookingStatus: booking.status,
    };
  },
});

const safetyVerdictArgValidator = v.object({
  verdict: v.union(v.literal("safe"), v.literal("violation")),
  reason: v.string(),
});

/** Writes the LLM's verdict onto the turn, and applies a strike only when it confirms a violation. */
export const applySafetyVerdict = internalMutation({
  args: { turnId: v.id("roomTurns"), bookingId: v.id("roomBookings"), role: roomScriptRoleValidator, verdict: safetyVerdictArgValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const turn = await ctx.db.get("roomTurns", args.turnId);
    if (turn === null) return null;
    await ctx.db.patch("roomTurns", args.turnId, {
      safety: { ...turn.safety, llmVerdict: args.verdict.verdict, llmReason: args.verdict.reason },
    });
    if (args.verdict.verdict === "violation") {
      await applyStrike(ctx, args.bookingId, args.role, args.verdict.reason);
    }
    return null;
  },
});

const streamContextValidator = v.object({
  role: roomScriptRoleValidator,
  targetLanguage: targetLanguageValidator,
  status: roomStatusValidator,
  minutes: v.number(),
  /** Only ever non-empty for the partner — see roomStreamConfig. */
  keyterms: v.array(v.string()),
});

export const streamContext = internalQuery({
  args: { bookingId: v.id("roomBookings"), userId: v.id("users") },
  returns: streamContextValidator,
  handler: async (ctx, args) => {
    const booking = await requireOwnedBooking(ctx, args.bookingId, args.userId);
    const role: RoomRole = booking.learnerId === args.userId ? "learner" : "partner";
    let keyterms: string[] = [];
    if (role === "partner") {
      const script = await ctx.db
        .query("roomScripts")
        .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
        .order("desc")
        .first();
      if (script !== null) keyterms = extractKeyterms(script.lines);
    }
    return { role, targetLanguage: booking.targetLanguage, status: booking.status, minutes: booking.minutes, keyterms };
  },
});

/** Auto-ends a room that nobody explicitly completed — scheduled from rooms.markBookingConfirmed at scheduledEndAt + AUTO_END_GRACE_MS. */
export const autoEndRoom = internalMutation({
  args: { bookingId: v.id("roomBookings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const booking = await ctx.db.get("roomBookings", args.bookingId);
    if (booking === null || booking.status !== "in_progress") return null; // never started, or already ended some other way
    await ctx.db.patch("roomBookings", args.bookingId, { status: "completed", updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.payments.captureAuthorizedPayment, {
      purpose: "room_booking",
      refId: args.bookingId,
    });
    await applyRoomEvidenceHandler(ctx, { bookingId: args.bookingId });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Evidence (Task C): a completed room's target words are the STRONGEST
// evidence tier — same nextWordStatus ladder labs.ts uses (correct=true,
// spoken=true always, since saying it in a live conversation IS the spoken
// confirmation). Room scripts carry no pattern reference, so only word
// status is ever updated here — there is no deterministic evidence source
// for grammar patterns from a room session.
// ---------------------------------------------------------------------------

async function applyRoomEvidenceHandler(ctx: MutationCtx, args: { bookingId: Id<"roomBookings"> }): Promise<void> {
  const booking = await ctx.db.get("roomBookings", args.bookingId);
  if (booking === null || booking.status !== "completed") return;
  const goal = await loadActiveGoal(ctx, booking.learnerId);
  if (goal === null) return; // no active goal to attribute evidence to (test data, or the learner switched goals)

  const turns = await ctx.db
    .query("roomTurns")
    .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
    .take(500);
  const words = new Set<string>();
  for (const turn of turns) {
    if (turn.role !== "learner") continue;
    for (const said of turn.targetWordsSaid) words.add(said.word);
  }

  const today = todayKey(Date.now());
  const movedToCanUse: string[] = [];
  for (const word of words) {
    const current = await currentWordStatus(ctx, { userId: booking.learnerId, goalId: goal._id, word });
    const next = nextWordStatus(current.status, true, true, current.wrongDays, today);
    await writeWordStatus(ctx, {
      userId: booking.learnerId,
      goalId: goal._id,
      word,
      existingId: current.existingId,
      status: next.status,
      wrongDays: next.wrongDays,
    });
    if (current.status !== "canUse" && next.status === "canUse") movedToCanUse.push(word);
  }
  await ctx.db.patch("roomBookings", args.bookingId, { wordsMovedToCanUse: movedToCanUse });
}

export const applyRoomEvidence = internalMutation({
  args: { bookingId: v.id("roomBookings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await applyRoomEvidenceHandler(ctx, args);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Safety classification (LLM Gateway, borderline tier only)
// ---------------------------------------------------------------------------

async function classifyTurnSafetyHandler(ctx: ActionCtx, args: { turnId: Id<"roomTurns"> }): Promise<null> {
  const context: typeof turnSafetyContextValidator.type | null = await ctx.runQuery(internal.liveRoom.turnSafetyContext, {
    turnId: args.turnId,
  });
  if (context === null || context.bookingStatus !== "in_progress") return null;

  let verdict: SafetyVerdict;
  try {
    verdict = await llmJson({
      system: SAFETY_SYSTEM_PROMPT,
      user: safetyUserPrompt(context.transcript, context.language),
      schemaName: "room_turn_safety",
      schema: SAFETY_JSON_SCHEMA,
      validate: validateSafetyVerdict,
      timeoutMs: 30_000,
      maxTokens: 300,
      recordCall: llmRecorder(ctx),
    });
  } catch {
    // A classification failure must never crash or block the room — the turn
    // already saved with its "borderline" ruleFlag for a human reviewer.
    return null;
  }

  await ctx.runMutation(internal.liveRoom.applySafetyVerdict, {
    turnId: args.turnId,
    bookingId: context.bookingId,
    role: context.role,
    verdict,
  });
  return null;
}

export const classifyTurnSafety = internalAction({
  args: { turnId: v.id("roomTurns") },
  returns: v.null(),
  handler: classifyTurnSafetyHandler,
});

// ---------------------------------------------------------------------------
// saveRoomTurn — the only way a transcript turn is ever written
// ---------------------------------------------------------------------------

const saveRoomTurnArgsValidator = {
  bookingId: v.id("roomBookings"),
  transcript: v.string(),
  words: v.array(transcriptWordValidator),
  startMs: v.number(),
  endMs: v.number(),
};

const saveRoomTurnResultValidator = v.object({
  turnId: v.id("roomTurns"),
  matchedLineIndex: v.union(v.number(), v.null()),
  targetWordsSaid: v.array(roomTargetWordSaidValidator),
  ruleFlag: roomSafetyFlagValidator,
});

async function saveRoomTurnHandler(
  ctx: MutationCtx,
  args: { bookingId: Id<"roomBookings">; transcript: string; words: RawTurnWord[]; startMs: number; endMs: number },
): Promise<typeof saveRoomTurnResultValidator.type> {
  const userId = await requireUserId(ctx);
  const booking = await requireOwnedBooking(ctx, args.bookingId, userId);
  if (booking.status !== "in_progress") invalid(`Cannot save a turn while the booking is "${booking.status}"`);
  // Speaker role comes from auth — never from the client.
  const role: RoomRole = booking.learnerId === userId ? "learner" : "partner";

  const transcript = args.transcript.trim().slice(0, MAX_TRANSCRIPT_CHARS);
  if (transcript.length === 0) invalid("transcript must not be empty");
  const words = sanitizeTurnWords(args.words);
  if (!Number.isFinite(args.startMs) || !Number.isFinite(args.endMs) || args.startMs < 0 || args.endMs < args.startMs) {
    invalid("startMs/endMs must be valid, with endMs >= startMs");
  }

  // --- deterministic script tracking (learner turns only) -------------------
  let matchedLineIndex: number | null = null;
  const targetWordsSaid: Array<{ word: string; confidence: number }> = [];
  const doneSet = new Set(booking.doneLineIndices ?? []);
  if (role === "learner") {
    const script = await ctx.db
      .query("roomScripts")
      .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
      .order("desc")
      .first();
    if (script !== null) {
      const expectedIdx = nextLearnerLineIndex(script.lines, doneSet);
      if (expectedIdx !== null) {
        const expectedLine = script.lines[expectedIdx]!;
        if (scriptLineMatches(transcript, expectedLine.text)) {
          matchedLineIndex = expectedIdx;
          doneSet.add(expectedIdx);
          for (const w of expectedLine.words) {
            if (containsPhrase(transcript, w)) {
              targetWordsSaid.push({ word: w, confidence: confidenceFor(w, words) ?? 0.5 });
            }
          }
        }
      }
    }
  }

  // --- fast rule check (deterministic, no LLM) -------------------------------
  // Checked against every language's blocklist, not just the booking's target
  // language — see ruleCheckAnyLanguage's own docstring for why.
  const ruleFlag = ruleCheckAnyLanguage(transcript);

  const now = Date.now();
  const turnId = await ctx.db.insert("roomTurns", {
    bookingId: args.bookingId,
    role,
    transcript,
    words,
    startMs: args.startMs,
    endMs: args.endMs,
    matchedLineIndex: matchedLineIndex ?? undefined,
    targetWordsSaid,
    safety: { ruleFlag },
    createdAt: now,
  });

  const patch: Record<string, unknown> = { updatedAt: now };
  if (matchedLineIndex !== null) patch.doneLineIndices = [...doneSet].sort((a, b) => a - b);
  // A learner turn is real speech — whatever the stuck cue was tracking is now moot.
  if (role === "learner" && booking.stuckCue === true) patch.stuckCue = false;
  await ctx.db.patch("roomBookings", args.bookingId, patch);

  // Never block the turn from saving on the safety outcome — it already saved above.
  if (ruleFlag === "violation") {
    await applyStrike(ctx, args.bookingId, role, "blocked term detected");
  } else if (ruleFlag === "borderline") {
    await ctx.scheduler.runAfter(0, internal.liveRoom.classifyTurnSafety, { turnId });
  }

  return { turnId, matchedLineIndex, targetWordsSaid, ruleFlag };
}

export const saveRoomTurn = mutation({
  args: saveRoomTurnArgsValidator,
  returns: saveRoomTurnResultValidator,
  handler: saveRoomTurnHandler,
});

// ---------------------------------------------------------------------------
// joinRoom — LiveKit token + join-state
// ---------------------------------------------------------------------------

const joinRoomResultValidator = v.object({
  token: v.string(),
  url: v.string(),
  identity: v.string(),
  role: roomScriptRoleValidator,
  expiresInSeconds: v.number(),
});

async function joinRoomHandler(
  ctx: ActionCtx,
  args: { bookingId: Id<"roomBookings"> },
): Promise<typeof joinRoomResultValidator.type> {
  const userId = await requireUserId(ctx);
  const context: typeof joinContextValidator.type = await ctx.runQuery(internal.liveRoom.joinContext, {
    bookingId: args.bookingId,
    userId,
  });
  if (context.status !== "confirmed" && context.status !== "in_progress") {
    invalid(`Cannot join a room whose booking is "${context.status}"`);
  }
  if (context.scheduledStartAt === null || context.scheduledEndAt === null) {
    invalid("This booking has no scheduled time");
  }
  const now = Date.now();
  if (!withinJoinWindow(now, context.scheduledStartAt, context.scheduledEndAt)) {
    forbidden(`You can join starting ${JOIN_WINDOW_BEFORE_START_MS / 60_000} minutes before the session, until it ends`);
  }
  await ctx.runMutation(internal.rooms.recordRoomJoin, { bookingId: args.bookingId, userId });

  const ttlSeconds = tokenTtlSeconds(now, context.scheduledEndAt);
  const minted = await mintRoomToken({ bookingId: args.bookingId, role: context.role, userId, ttlSeconds });
  return { token: minted.token, url: minted.url, identity: minted.identity, role: context.role, expiresInSeconds: ttlSeconds };
}

/** Checks ownership + the "confirmed" booking + the join time window, records the join, and mints a short-lived, audio-only LiveKit access token. */
export const joinRoom = action({
  args: { bookingId: v.id("roomBookings") },
  returns: joinRoomResultValidator,
  handler: joinRoomHandler,
});

// ---------------------------------------------------------------------------
// roomStreamConfig — per-participant AssemblyAI streaming session
// ---------------------------------------------------------------------------

const roomStreamConfigResultValidator = v.object({
  role: roomScriptRoleValidator,
  language: targetLanguageValidator,
  speechModel: v.string(),
  token: v.string(),
  expiresInSeconds: v.number(),
  websocketUrl: v.string(),
  connectionParams: v.object({
    speech_model: v.string(),
    language_detection: v.literal("true"),
    /** JSON-encoded array of terms — only set for the partner, from the script's names/topic words. */
    keyterms_prompt: v.optional(v.string()),
  }),
});

async function roomStreamConfigHandler(
  ctx: ActionCtx,
  args: { bookingId: Id<"roomBookings"> },
): Promise<typeof roomStreamConfigResultValidator.type> {
  const userId = await requireUserId(ctx);
  const context: typeof streamContextValidator.type = await ctx.runQuery(internal.liveRoom.streamContext, {
    bookingId: args.bookingId,
    userId,
  });
  if (context.status !== "confirmed" && context.status !== "in_progress") {
    invalid(`Cannot stream while the booking is "${context.status}"`);
  }

  const streaming = await createStreamingToken({
    expiresInSeconds: 60,
    maxSessionDurationSeconds: Math.min(STREAM_MAX_SESSION_SECONDS, Math.max(600, context.minutes * 60 + 300)),
  });

  const connectionParams: { speech_model: string; language_detection: "true"; keyterms_prompt?: string } = {
    speech_model: STREAM_MODEL_TARGET,
    language_detection: "true",
  };
  // Learner: no keyterms, so scores stay honest. Partner: keyterms from the script's names/topic words.
  if (context.role === "partner" && context.keyterms.length > 0) {
    connectionParams.keyterms_prompt = JSON.stringify(context.keyterms);
  }

  return {
    role: context.role,
    language: context.targetLanguage,
    speechModel: STREAM_MODEL_TARGET,
    token: streaming.token,
    expiresInSeconds: streaming.expiresInSeconds,
    websocketUrl: streaming.websocketUrl,
    connectionParams,
  };
}

export const roomStreamConfig = action({
  args: { bookingId: v.id("roomBookings") },
  returns: roomStreamConfigResultValidator,
  handler: roomStreamConfigHandler,
});

// ---------------------------------------------------------------------------
// Stuck detection
// ---------------------------------------------------------------------------

/** The client calls this after observing ~8s of learner silence following a partner line; the server independently re-checks against the last saved turn's own timestamp. */
export const reportSilence = mutation({
  args: { bookingId: v.id("roomBookings"), seconds: v.number() },
  returns: v.object({ stuckCue: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const booking = await requireOwnedBooking(ctx, args.bookingId, userId);
    if (booking.learnerId !== userId) forbidden("Only the learner reports silence");
    if (booking.status !== "in_progress") invalid(`Cannot report silence while the booking is "${booking.status}"`);
    if (!Number.isFinite(args.seconds) || args.seconds < 0) invalid("seconds must be a non-negative number");

    const lastTurn = await ctx.db
      .query("roomTurns")
      .withIndex("by_booking_and_createdAt", (q) => q.eq("bookingId", args.bookingId))
      .order("desc")
      .first();
    const now = Date.now();
    // Server-side truth: the partner must have spoken last, and real wall-clock
    // time must actually have passed — the client's own `seconds` is only a hint.
    const validStuck = lastTurn !== null && lastTurn.role === "partner" && now - lastTurn.createdAt >= STUCK_SILENCE_MS;
    if (validStuck) {
      await ctx.db.patch("roomBookings", args.bookingId, {
        stuckCue: true,
        stuckCount: (booking.stuckCount ?? 0) + 1,
        updatedAt: now,
      });
    }
    return { stuckCue: validStuck };
  },
});

// ---------------------------------------------------------------------------
// reportUser
// ---------------------------------------------------------------------------

/** Either party can report the other. Stored for later review — never ends the room by itself. */
export const reportUser = mutation({
  args: { bookingId: v.id("roomBookings"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const booking = await requireOwnedBooking(ctx, args.bookingId, userId);
    const reason = args.reason.trim();
    if (reason.length === 0) invalid("reason must not be empty");
    if (reason.length > MAX_REPORT_REASON_CHARS) invalid(`reason must be at most ${MAX_REPORT_REASON_CHARS} characters`);
    const reporterRole: RoomRole = booking.learnerId === userId ? "learner" : "partner";
    const reportedRole: RoomRole = reporterRole === "learner" ? "partner" : "learner";
    await ctx.db.insert("roomReports", { bookingId: args.bookingId, reporterRole, reportedRole, reason, createdAt: Date.now() });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Recording upload
// ---------------------------------------------------------------------------

/** Each client records its own mic locally and uploads once the room ends. */
export const generateRoomUploadUrl = mutation({
  args: { bookingId: v.id("roomBookings") },
  returns: v.string(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedBooking(ctx, args.bookingId, userId); // ownership only; any booking status — the upload happens after the room ends
    return await ctx.storage.generateUploadUrl();
  },
});

export const attachRoomRecording = mutation({
  args: { bookingId: v.id("roomBookings"), storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const booking = await requireOwnedBooking(ctx, args.bookingId, userId);
    // Role from auth, exactly like everywhere else in this file.
    if (booking.learnerId === userId) {
      await ctx.db.patch("roomBookings", args.bookingId, { learnerRecordingStorageId: args.storageId, updatedAt: Date.now() });
    } else {
      await ctx.db.patch("roomBookings", args.bookingId, { partnerRecordingStorageId: args.storageId, updatedAt: Date.now() });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// recentTurns — the transcript so far (also doubles as proof that a saved
// turn's `role` came from auth: nothing in saveRoomTurn's args can set it).
// ---------------------------------------------------------------------------

const roomTurnViewValidator = v.object({
  role: roomScriptRoleValidator,
  transcript: v.string(),
  matchedLineIndex: v.union(v.number(), v.null()),
  targetWordsSaid: v.array(roomTargetWordSaidValidator),
  ruleFlag: roomSafetyFlagValidator,
  createdAt: v.number(),
});

export const recentTurns = query({
  args: { bookingId: v.id("roomBookings"), limit: v.optional(v.number()) },
  returns: v.array(roomTurnViewValidator),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedBooking(ctx, args.bookingId, userId);
    const limit = Math.min(200, Math.max(1, args.limit ?? 50));
    const turns = await ctx.db
      .query("roomTurns")
      .withIndex("by_booking_and_createdAt", (q) => q.eq("bookingId", args.bookingId))
      .order("desc")
      .take(limit);
    return turns
      .map((t) => ({
        role: t.role,
        transcript: t.transcript,
        matchedLineIndex: t.matchedLineIndex ?? null,
        targetWordsSaid: t.targetWordsSaid,
        ruleFlag: t.safety.ruleFlag,
        createdAt: t.createdAt,
      }))
      .reverse();
  },
});

// ---------------------------------------------------------------------------
// roomState — everything both live-room screens need, in one query
// ---------------------------------------------------------------------------

const roomStateValidator = v.object({
  status: roomStatusValidator,
  role: roomScriptRoleValidator,
  scheduledStartAt: v.union(v.number(), v.null()),
  scheduledEndAt: v.union(v.number(), v.null()),
  /** From the server clock — never trust a client's own timer. */
  msRemaining: v.number(),
  learnerJoined: v.boolean(),
  partnerJoined: v.boolean(),
  currentLineIndex: v.union(v.number(), v.null()),
  doneLineIndices: v.array(v.number()),
  totalLines: v.number(),
  targetWordsSaid: v.array(roomTargetWordSaidValidator),
  stuckCue: v.boolean(),
  myStrikes: v.number(),
  otherStrikes: v.number(),
  warning: v.union(roomWarningValidator, v.null()),
  endedReason: v.union(roomStatusValidator, v.null()),
  violatorRole: v.union(roomScriptRoleValidator, v.null()),
});

const ENDED_STATUSES: ReadonlySet<Doc<"roomBookings">["status"]> = new Set([
  "completed",
  "no_show_partner",
  "no_show_learner",
  "ended_violation",
  "cancelled",
]);

export const roomState = query({
  args: { bookingId: v.id("roomBookings") },
  returns: roomStateValidator,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const booking = await requireOwnedBooking(ctx, args.bookingId, userId);
    const role: RoomRole = booking.learnerId === userId ? "learner" : "partner";
    const now = Date.now();

    const script = await ctx.db
      .query("roomScripts")
      .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
      .order("desc")
      .first();
    const doneLineIndices = booking.doneLineIndices ?? [];
    const currentLineIndex = script !== null ? nextLearnerLineIndex(script.lines, new Set(doneLineIndices)) : null;

    // Best confidence per target word said, aggregated across every learner turn so far.
    const turns = await ctx.db
      .query("roomTurns")
      .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
      .take(500);
    const bestByWord = new Map<string, number>();
    for (const turn of turns) {
      if (turn.role !== "learner") continue;
      for (const said of turn.targetWordsSaid) {
        const prev = bestByWord.get(said.word);
        if (prev === undefined || said.confidence > prev) bestByWord.set(said.word, said.confidence);
      }
    }

    return {
      status: booking.status,
      role,
      scheduledStartAt: booking.scheduledStartAt ?? null,
      scheduledEndAt: booking.scheduledEndAt ?? null,
      msRemaining: booking.scheduledEndAt !== undefined ? Math.max(0, booking.scheduledEndAt - now) : 0,
      learnerJoined: booking.learnerJoinedAt !== undefined,
      partnerJoined: booking.partnerJoinedAt !== undefined,
      currentLineIndex,
      doneLineIndices,
      totalLines: script?.lines.length ?? 0,
      targetWordsSaid: [...bestByWord.entries()].map(([word, confidence]) => ({ word, confidence })),
      stuckCue: booking.stuckCue === true,
      myStrikes: (role === "learner" ? booking.learnerStrikes : booking.partnerStrikes) ?? 0,
      otherStrikes: (role === "learner" ? booking.partnerStrikes : booking.learnerStrikes) ?? 0,
      warning: booking.lastWarning ?? null,
      endedReason: ENDED_STATUSES.has(booking.status) ? booking.status : null,
      violatorRole: booking.violatorRole ?? null,
    };
  },
});

// ---------------------------------------------------------------------------
// Session report (Task C): rules-first stats (see lib/liveRoom.ts) + one LLM
// feedback call in the learner's own language, generated once and cached on
// the booking. Only ever available once the booking is "completed" — a
// no-show/cancelled/violation session has no real conversation to report on.
// ---------------------------------------------------------------------------

const reportContextValidator = v.object({
  status: roomStatusValidator,
  existingReport: v.union(roomReportValidator, v.null()),
  scenario: v.string(),
  primaryLanguage: v.string(),
  totalLearnerLines: v.number(),
  linesDone: v.number(),
  stuckCount: v.number(),
  wordsMovedToCanUse: v.array(v.string()),
  turns: v.array(
    v.object({
      role: roomScriptRoleValidator,
      startMs: v.number(),
      endMs: v.number(),
      wordsCount: v.number(),
      targetWordsSaid: v.array(v.string()),
    }),
  ),
});

export const reportContext = internalQuery({
  args: { bookingId: v.id("roomBookings"), userId: v.id("users") },
  returns: reportContextValidator,
  handler: async (ctx, args) => {
    const booking = await requireOwnedBooking(ctx, args.bookingId, args.userId);
    const script = await ctx.db
      .query("roomScripts")
      .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
      .order("desc")
      .first();
    const totalLearnerLines = script?.lines.filter((l) => l.role === "learner").length ?? 0;

    const turnRows = await ctx.db
      .query("roomTurns")
      .withIndex("by_booking", (q) => q.eq("bookingId", args.bookingId))
      .take(500);
    const turns = turnRows.map((t) => ({
      role: t.role,
      startMs: t.startMs,
      endMs: t.endMs,
      wordsCount: t.words.length,
      targetWordsSaid: t.targetWordsSaid.map((w) => w.word),
    }));

    const learner = await ctx.db.get("users", booking.learnerId);
    const primaryLanguage: KnownLanguage = learner?.primaryLanguage ?? "en";

    return {
      status: booking.status,
      existingReport: booking.report ?? null,
      scenario: booking.scenario,
      primaryLanguage: LANGUAGE_NAMES[primaryLanguage],
      totalLearnerLines,
      linesDone: (booking.doneLineIndices ?? []).length,
      stuckCount: booking.stuckCount ?? 0,
      wordsMovedToCanUse: booking.wordsMovedToCanUse ?? [],
      turns,
    };
  },
});

export const saveReport = internalMutation({
  args: { bookingId: v.id("roomBookings"), report: roomReportValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const booking = await ctx.db.get("roomBookings", args.bookingId);
    if (booking === null || booking.report !== undefined) return null; // idempotent — never overwrite an existing report
    await ctx.db.patch("roomBookings", args.bookingId, { report: args.report });
    return null;
  },
});

async function generateReportHandler(
  ctx: ActionCtx,
  args: { bookingId: Id<"roomBookings"> },
): Promise<typeof roomReportValidator.type> {
  const userId = await requireUserId(ctx);
  const context: typeof reportContextValidator.type = await ctx.runQuery(internal.liveRoom.reportContext, {
    bookingId: args.bookingId,
    userId,
  });
  if (context.status !== "completed") {
    invalid(`Report is only available once the session is "completed" (this one is "${context.status}")`);
  }
  if (context.existingReport !== null) return context.existingReport; // generated once — no further LLM call

  const stats = computeRoomReportStats({
    turns: context.turns as ReportTurnLike[],
    totalLearnerLines: context.totalLearnerLines,
    linesDone: context.linesDone,
    stuckCount: context.stuckCount,
  });

  const { feedback } = await llmJson({
    system: ROOM_REPORT_SYSTEM,
    user: roomReportPrompt({ scenario: context.scenario, primaryLanguageName: context.primaryLanguage, stats }),
    schemaName: "room_report_feedback",
    schema: ROOM_REPORT_JSON_SCHEMA,
    validate: validateRoomReportFeedback,
    timeoutMs: 30_000,
    maxTokens: 400,
    recordCall: llmRecorder(ctx),
  });

  const report: typeof roomReportValidator.type = {
    ...stats,
    wordsMovedToCanUse: context.wordsMovedToCanUse,
    feedback,
    generatedAt: Date.now(),
  };
  await ctx.runMutation(internal.liveRoom.saveReport, { bookingId: args.bookingId, report });
  return report;
}

/** Generates the session report once (rules-first stats + one LLM feedback call). A second call is a no-op that returns the saved report. */
export const generateReport = action({
  args: { bookingId: v.id("roomBookings") },
  returns: roomReportValidator,
  handler: generateReportHandler,
});

/** The saved report, or `null` if it has not been generated yet (the report screen calls `generateReport` to produce it). */
export const report = query({
  args: { bookingId: v.id("roomBookings") },
  returns: v.union(roomReportValidator, v.null()),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const booking = await requireOwnedBooking(ctx, args.bookingId, userId);
    return booking.report ?? null;
  },
});
