/**
 * Level check: read 5 words aloud, then answer 2 spoken prompts.
 *
 * Audio never passes through Convex for the English/streaming path — the
 * browser talks to AssemblyAI directly using a short-lived token minted by
 * `getStreamingToken`, and posts only the FINAL transcript back via
 * `saveAttempt`. Non-English answers are uploaded to Convex file storage and
 * transcribed server-side by `transcribeRecorded`.
 */

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  attemptKindValidator,
  attemptSourceValidator,
  levelCheckPromptValidator,
  transcriptWordValidator,
} from "./schema";
import {
  invalid,
  loadActiveGoal,
  notFound,
  requireOwnedLevelCheck,
  requireUser,
  requireUserId,
} from "./lib/authz";
import {
  createStreamingToken,
  transcribeRecordedAudio,
  type TranscriptWord,
} from "./lib/assemblyai";
import {
  generationLanguages,
  readLanguageProfile,
  streamRouteFor,
  type KnownLanguage,
  type TargetLanguage,
} from "./lib/languages";
import { LEVEL_CHECK_PROMPT_COUNT, LEVEL_CHECK_WORD_COUNT } from "./lib/validate";

const MAX_TRANSCRIPT_CHARS = 4000;
const MAX_TRANSCRIPT_WORDS = 500;

// ---------------------------------------------------------------------------
// startLevelCheck
// ---------------------------------------------------------------------------

const startLevelCheckResult = v.object({
  levelCheckId: v.id("levelChecks"),
  goalId: v.id("goals"),
  words: v.array(v.string()),
  prompts: v.array(levelCheckPromptValidator),
});

/** Begins a level check against the caller's active goal. */
export const startLevelCheck = mutation({
  args: {},
  returns: startLevelCheckResult,
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const goal = await loadActiveGoal(ctx, userId);
    if (goal === null) {
      invalid("You have no active goal. Call goals.setGoal first.");
    }

    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
      .first();
    if (targets === null) {
      invalid(
        "Goal targets are still being generated. Poll goals.activeGoal until targetsReady is true.",
      );
    }

    const levelCheckId = await ctx.db.insert("levelChecks", {
      userId,
      goalId: goal._id,
      status: "started",
      createdAt: Date.now(),
    });

    return {
      levelCheckId,
      goalId: goal._id,
      words: targets.levelCheckWords,
      prompts: targets.levelCheckPrompts,
    };
  },
});

// ---------------------------------------------------------------------------
// getStreamingToken
// ---------------------------------------------------------------------------

/**
 * Mints a short-lived AssemblyAI streaming token for the signed-in caller.
 * The ASSEMBLYAI_API_KEY never leaves the server; only this token does.
 */
export const getStreamingToken = action({
  args: {},
  returns: v.object({
    token: v.string(),
    expiresInSeconds: v.number(),
    websocketUrl: v.string(),
  }),
  handler: async (ctx) => {
    // Auth gate: tokens cost money, so never hand one to an anonymous caller.
    await requireUserId(ctx);
    return await createStreamingToken();
  },
});

// ---------------------------------------------------------------------------
// getStreamConfig
// ---------------------------------------------------------------------------

const streamLanguageValidator = v.union(
  v.literal("en"),
  v.literal("de"),
  v.literal("hi"),
  v.literal("te"),
);

/**
 * Which AssemblyAI `speech_model` the browser must put in the streaming
 * WebSocket URL for what the learner is about to say:
 *
 *   purpose "target" -> speaking the target language (en / de): u3-rt-pro
 *   purpose "own"    -> answering in their own language: whisper-rt for
 *                       hi / te; u3-rt-pro when their own language is en
 *
 * Languages come from the active goal's generation snapshot when there is
 * one — the words the learner is practising were generated in exactly those
 * languages — and from the live profile otherwise.
 *
 * `connectionParams` are added to the WebSocket URL verbatim, alongside the
 * client's own token / sample_rate / encoding. `language_detection=true` was
 * verified live on both models: u3-rt-pro only reports `language_code` when
 * it is set; whisper-rt detects natively and accepts it harmlessly. Scoring
 * relies on the detected language to tell off-target answers apart.
 */
export const getStreamConfig = query({
  args: { purpose: v.union(v.literal("target"), v.literal("own")) },
  returns: v.object({
    purpose: v.union(v.literal("target"), v.literal("own")),
    /** The language the learner is expected to speak on this stream. */
    language: streamLanguageValidator,
    /** Value for the WebSocket `speech_model` query parameter. */
    speechModel: v.string(),
    /** Extra WebSocket query parameters, to be added verbatim. */
    connectionParams: v.object({
      speech_model: v.string(),
      language_detection: v.literal("true"),
    }),
    languageSource: v.union(v.literal("goal"), v.literal("profile")),
  }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const profile = readLanguageProfile(user);

    let languages: { targetLanguage: TargetLanguage; primaryLanguage: KnownLanguage } | null =
      profile === null
        ? null
        : { targetLanguage: profile.targetLanguage, primaryLanguage: profile.primaryLanguage };
    let languageSource: "goal" | "profile" = "profile";

    const goal = await loadActiveGoal(ctx, user._id);
    if (goal !== null) {
      const targets = await ctx.db
        .query("goalTargets")
        .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
        .first();
      if (targets !== null) {
        const generated = generationLanguages(targets, profile);
        languages = {
          targetLanguage: generated.targetLanguage,
          primaryLanguage: generated.primaryLanguage,
        };
        languageSource = "goal";
      }
    }

    if (languages === null) {
      invalid("Choose your languages first: call users.updateProfile before streaming.");
    }

    const route = streamRouteFor(args.purpose, languages);
    return {
      purpose: args.purpose,
      language: route.language,
      speechModel: route.speechModel,
      connectionParams: {
        speech_model: route.speechModel,
        language_detection: "true" as const,
      },
      languageSource,
    };
  },
});

// ---------------------------------------------------------------------------
// saveAttempt
// ---------------------------------------------------------------------------

function sanitizeTranscriptWords(
  raw: Array<{ text: string; confidence: number; start: number; end: number }>,
): TranscriptWord[] {
  if (raw.length > MAX_TRANSCRIPT_WORDS) {
    invalid(`words must contain at most ${MAX_TRANSCRIPT_WORDS} entries`);
  }
  return raw.map((word, i) => {
    if (!Number.isFinite(word.confidence)) {
      invalid(`words[${i}].confidence must be a finite number`);
    }
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end)) {
      invalid(`words[${i}].start and words[${i}].end must be finite numbers`);
    }
    return {
      text: word.text.slice(0, 200),
      // Confidence is a probability; clamp so a hostile client cannot inflate it.
      confidence: Math.min(1, Math.max(0, word.confidence)),
      start: Math.max(0, word.start),
      end: Math.max(0, word.end),
    };
  });
}

/**
 * Stores the FINAL transcript for one attempt slot. Partial/interim streaming
 * results must never be sent here.
 *
 * `expected` is accepted for client convenience but is NOT trusted: the value
 * written to the database always comes from the server's own goalTargets row,
 * because scoring compares against it.
 */
export const saveAttempt = mutation({
  args: {
    levelCheckId: v.id("levelChecks"),
    kind: attemptKindValidator,
    index: v.number(),
    expected: v.string(),
    transcript: v.string(),
    words: v.array(transcriptWordValidator),
    source: attemptSourceValidator,
    languageDetected: v.optional(v.string()),
  },
  returns: v.id("attempts"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const levelCheck = await requireOwnedLevelCheck(ctx, args.levelCheckId, userId);
    if (levelCheck.status !== "started") {
      invalid(
        `This level check is "${levelCheck.status}"; attempts can only be saved while it is "started".`,
      );
    }

    const slotCount =
      args.kind === "word" ? LEVEL_CHECK_WORD_COUNT : LEVEL_CHECK_PROMPT_COUNT;
    if (
      !Number.isInteger(args.index) ||
      args.index < 0 ||
      args.index >= slotCount
    ) {
      invalid(`index must be an integer in 0..${slotCount - 1} for kind "${args.kind}"`);
    }
    if (args.transcript.length > MAX_TRANSCRIPT_CHARS) {
      invalid(`transcript must be at most ${MAX_TRANSCRIPT_CHARS} characters`);
    }

    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", levelCheck.goalId))
      .first();
    if (targets === null) notFound("Goal targets for this level check are missing");

    const expected =
      args.kind === "word"
        ? (targets.levelCheckWords[args.index] ?? "")
        : (targets.levelCheckPrompts[args.index]?.english ?? "");
    if (expected.length === 0) {
      invalid(`No ${args.kind} exists at index ${args.index} for this goal`);
    }

    const words = sanitizeTranscriptWords(args.words);
    const transcript = args.transcript.trim();

    // Idempotent per slot: a client retry replaces its own attempt rather than
    // appending a duplicate that would skew the deterministic scoring pass.
    const existing = await ctx.db
      .query("attempts")
      .withIndex("by_level_check_and_kind_and_index", (q) =>
        q.eq("levelCheckId", args.levelCheckId).eq("kind", args.kind).eq("index", args.index),
      )
      .first();

    if (existing !== null) {
      await ctx.db.patch("attempts", existing._id, {
        expected,
        transcript,
        words,
        source: args.source,
        languageDetected: args.languageDetected,
      });
      return existing._id;
    }

    return await ctx.db.insert("attempts", {
      levelCheckId: args.levelCheckId,
      kind: args.kind,
      index: args.index,
      expected,
      transcript,
      words,
      source: args.source,
      languageDetected: args.languageDetected,
      createdAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// transcribeRecorded
// ---------------------------------------------------------------------------

/** Internal: ownership check for an action that has no `ctx.db`. */
export const assertOwnsLevelCheck = internalQuery({
  args: { levelCheckId: v.id("levelChecks"), userId: v.id("users") },
  returns: v.object({ goalId: v.id("goals"), status: v.string() }),
  handler: async (ctx, args) => {
    const levelCheck = await requireOwnedLevelCheck(ctx, args.levelCheckId, args.userId);
    return { goalId: levelCheck.goalId, status: levelCheck.status };
  },
});

/** Internal: writes a recorded-source attempt on behalf of `transcribeRecorded`. */
export const saveRecordedAttempt = internalMutation({
  args: {
    levelCheckId: v.id("levelChecks"),
    userId: v.id("users"),
    index: v.number(),
    transcript: v.string(),
    words: v.array(transcriptWordValidator),
    languageDetected: v.optional(v.string()),
  },
  returns: v.id("attempts"),
  handler: async (ctx, args): Promise<Id<"attempts">> => {
    const levelCheck = await requireOwnedLevelCheck(ctx, args.levelCheckId, args.userId);
    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", levelCheck.goalId))
      .first();
    if (targets === null) notFound("Goal targets for this level check are missing");
    const expected = targets.levelCheckPrompts[args.index]?.english ?? "";
    if (expected.length === 0) {
      invalid(`No prompt exists at index ${args.index} for this goal`);
    }

    const existing = await ctx.db
      .query("attempts")
      .withIndex("by_level_check_and_kind_and_index", (q) =>
        q.eq("levelCheckId", args.levelCheckId).eq("kind", "prompt").eq("index", args.index),
      )
      .first();

    const fields = {
      expected,
      transcript: args.transcript.slice(0, MAX_TRANSCRIPT_CHARS).trim(),
      words: args.words,
      source: "recorded" as const,
      languageDetected: args.languageDetected,
    };

    if (existing !== null) {
      await ctx.db.patch("attempts", existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("attempts", {
      levelCheckId: args.levelCheckId,
      kind: "prompt",
      index: args.index,
      createdAt: Date.now(),
      ...fields,
    });
  },
});

/**
 * Transcribes a prompt answer that was NOT spoken in English.
 * The client uploads the audio to Convex file storage first and passes the
 * resulting storageId here; language detection is done by AssemblyAI.
 */
export const transcribeRecorded = action({
  args: {
    levelCheckId: v.id("levelChecks"),
    index: v.number(),
    storageId: v.id("_storage"),
  },
  returns: v.object({
    attemptId: v.id("attempts"),
    transcript: v.string(),
    languageDetected: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    if (
      !Number.isInteger(args.index) ||
      args.index < 0 ||
      args.index >= LEVEL_CHECK_PROMPT_COUNT
    ) {
      invalid(`index must be an integer in 0..${LEVEL_CHECK_PROMPT_COUNT - 1}`);
    }

    // Ownership is checked through an internal query: actions have no ctx.db.
    const levelCheck = await ctx.runQuery(internal.levelCheck.assertOwnsLevelCheck, {
      levelCheckId: args.levelCheckId,
      userId,
    });
    if (levelCheck.status !== "started") {
      invalid(
        `This level check is "${levelCheck.status}"; attempts can only be saved while it is "started".`,
      );
    }

    const audio = await ctx.storage.get(args.storageId);
    if (audio === null) notFound("Audio file not found in storage");

    const result = await transcribeRecordedAudio(audio);

    const attemptId: Id<"attempts"> = await ctx.runMutation(
      internal.levelCheck.saveRecordedAttempt,
      {
        levelCheckId: args.levelCheckId,
        userId,
        index: args.index,
        transcript: result.transcript,
        words: result.words,
        languageDetected: result.languageDetected ?? undefined,
      },
    );

    return {
      attemptId,
      transcript: result.transcript,
      languageDetected: result.languageDetected,
    };
  },
});

// ---------------------------------------------------------------------------
// finishLevelCheck
// ---------------------------------------------------------------------------

/** Moves the level check into scoring and schedules the scoring action. */
export const finishLevelCheck = mutation({
  args: { levelCheckId: v.id("levelChecks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const levelCheck = await requireOwnedLevelCheck(ctx, args.levelCheckId, userId);

    if (levelCheck.status === "processing" || levelCheck.status === "done") {
      // Idempotent: a retry must not schedule a second scoring run.
      return null;
    }

    const attempts = await ctx.db
      .query("attempts")
      .withIndex("by_level_check", (q) => q.eq("levelCheckId", args.levelCheckId))
      .take(LEVEL_CHECK_WORD_COUNT + LEVEL_CHECK_PROMPT_COUNT + 1);
    if (attempts.length === 0) {
      invalid("Save at least one attempt before finishing the level check");
    }

    await ctx.db.patch("levelChecks", args.levelCheckId, {
      status: "processing",
      error: undefined,
    });

    await ctx.scheduler.runAfter(0, internal.scoring.scoreLevelCheck, {
      levelCheckId: args.levelCheckId,
      userId,
    });

    return null;
  },
});
