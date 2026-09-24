import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export const goalTypeValidator = v.union(
  v.literal("daily_life"),
  v.literal("doctor"),
  v.literal("job_interview"),
  v.literal("work"),
  v.literal("travel"),
  v.literal("teacher"),
  v.literal("custom"),
);

export const deadlineValidator = v.union(
  v.literal("today"),
  v.literal("this_week"),
  v.literal("2_4_weeks"),
  v.literal("1_3_months"),
  v.literal("none"),
);

export const minutesPerDayValidator = v.union(
  v.literal(5),
  v.literal(15),
  v.literal(30),
  v.literal(45),
);

export const genderValidator = v.union(
  v.literal("female"),
  v.literal("male"),
  v.literal("unspecified"),
);

/** Languages a learner can already speak. Mirrors KNOWN_LANGUAGES in lib/languages. */
export const knownLanguageValidator = v.union(
  v.literal("en"),
  v.literal("hi"),
  v.literal("te"),
);

/** Languages a learner can learn. Mirrors TARGET_LANGUAGES in lib/languages. */
export const targetLanguageValidator = v.union(v.literal("en"), v.literal("de"));

export const levelCheckStatusValidator = v.union(
  v.literal("started"),
  v.literal("processing"),
  v.literal("done"),
  v.literal("failed"),
);

export const attemptKindValidator = v.union(v.literal("word"), v.literal("prompt"));

export const attemptSourceValidator = v.union(
  v.literal("streaming"),
  v.literal("recorded"),
);

export const levelValidator = v.union(
  v.literal("starting"),
  v.literal("basic"),
  v.literal("intermediate"),
  v.literal("confident"),
);

export const grammarStatusValidator = v.union(
  v.literal("ok"),
  v.literal("practising"),
  v.literal("not_yet"),
);

export const planModeValidator = v.union(v.literal("week"), v.literal("quick_prep"));

export const purchaseTypeValidator = v.union(
  v.literal("day"),
  v.literal("week"),
  v.literal("quick_prep"),
  v.literal("regen"),
);

export const goalWordValidator = v.object({
  /** In the goal's targetLanguage. */
  word: v.string(),
  /** In the goal's primaryLanguage. */
  meaning: v.string(),
  priority: v.number(),
  /**
   * How the target word sounds, written in the primaryLanguage script.
   * Optional in storage only because words generated before hints existed
   * lack it; newly generated LLM output is REQUIRED to include it.
   */
  pronunciationHint: v.optional(v.string()),
});

export const goalPatternValidator = v.object({
  pattern: v.string(),
  example: v.string(),
  meaning: v.string(),
});

/**
 * Field names predate multi-language support and are kept for storage
 * compatibility: `english` holds the prompt in the goal's TARGET language
 * (German for a de learner), `native` its translation in the PRIMARY language.
 */
export const levelCheckPromptValidator = v.object({
  english: v.string(),
  native: v.string(),
});

export const transcriptWordValidator = v.object({
  text: v.string(),
  confidence: v.number(),
  start: v.number(),
  end: v.number(),
});

export const grammarResultValidator = v.object({
  name: v.string(),
  status: grammarStatusValidator,
});

export const planWordValidator = v.object({
  word: v.string(),
  meaning: v.string(),
  /** Copied deterministically from goalTargets by word — never LLM-generated here. */
  pronunciationHint: v.optional(v.string()),
});

export const planDayValidator = v.object({
  dayNo: v.number(),
  title: v.string(),
  words: v.array(planWordValidator),
  patterns: v.array(v.string()),
  practiceSummary: v.string(),
});

export default defineSchema({
  // Convex Auth tables (authAccounts, authSessions, authVerifiers, users, ...).
  // `authTables.users` is extended below with SpeakUp profile fields.
  ...authTables,

  users: defineTable({
    // Fields owned by @convex-dev/auth
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    image: v.optional(v.string()),
    isAnonymous: v.optional(v.boolean()),
    // SpeakUp profile fields (optional: rows are created by the auth provider first)
    knownLanguages: v.optional(v.array(knownLanguageValidator)),
    primaryLanguage: v.optional(knownLanguageValidator),
    targetLanguage: v.optional(targetLanguageValidator),
    // The legacy `nativeLanguage` field was migrated into the three fields
    // above by migrations.backfillUserLanguages and removed (widen-migrate-
    // narrow). No row carries it any more, so the schema no longer allows it.
    gender: v.optional(genderValidator),
    createdAt: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),

  goals: defineTable({
    userId: v.id("users"),
    goalType: goalTypeValidator,
    goalText: v.string(),
    deadline: deadlineValidator,
    minutesPerDay: minutesPerDayValidator,
    active: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_active", ["userId", "active"]),

  goalTargets: defineTable({
    goalId: v.id("goals"),
    words: v.array(goalWordValidator),
    patterns: v.array(goalPatternValidator),
    levelCheckWords: v.array(v.string()),
    levelCheckPrompts: v.array(levelCheckPromptValidator),
    /**
     * Snapshot of the languages these targets were ACTUALLY generated in.
     * Scoring and stream routing read these, never the live profile, so a
     * later profile change cannot make German words be scored or streamed as
     * English. Optional only for rows generated before the snapshot existed;
     * those were English-target by construction (see lib/languages).
     */
    targetLanguage: v.optional(targetLanguageValidator),
    primaryLanguage: v.optional(knownLanguageValidator),
    createdAt: v.number(),
  }).index("by_goal", ["goalId"]),

  levelChecks: defineTable({
    userId: v.id("users"),
    goalId: v.id("goals"),
    status: levelCheckStatusValidator,
    error: v.optional(v.string()),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_goal", ["goalId"])
    .index("by_user_and_status", ["userId", "status"]),

  attempts: defineTable({
    levelCheckId: v.id("levelChecks"),
    kind: attemptKindValidator,
    index: v.number(),
    expected: v.string(),
    transcript: v.string(),
    words: v.array(transcriptWordValidator),
    source: attemptSourceValidator,
    languageDetected: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_level_check", ["levelCheckId"])
    .index("by_level_check_and_kind_and_index", ["levelCheckId", "kind", "index"]),

  levelResults: defineTable({
    levelCheckId: v.id("levelChecks"),
    userId: v.id("users"),
    goalId: v.id("goals"),
    canUse: v.array(v.string()),
    practising: v.array(v.string()),
    notYet: v.array(v.string()),
    grammar: v.array(grammarResultValidator),
    speakingSummary: v.string(),
    level: levelValidator,
    knownCount: v.number(),
    totalCount: v.number(),
    createdAt: v.number(),
  })
    .index("by_level_check", ["levelCheckId"])
    .index("by_user", ["userId"])
    .index("by_goal", ["goalId"]),

  plans: defineTable({
    userId: v.id("users"),
    goalId: v.id("goals"),
    mode: planModeValidator,
    minutesPerDay: minutesPerDayValidator,
    days: v.array(planDayValidator),
    generatedAt: v.number(),
  })
    .index("by_goal", ["goalId"])
    .index("by_user", ["userId"]),

  purchases: defineTable({
    userId: v.id("users"),
    planId: v.id("plans"),
    type: purchaseTypeValidator,
    dayNo: v.optional(v.number()),
    amountUsd: v.number(),
    status: v.literal("paid"),
    isDemo: v.literal(true),
    createdAt: v.number(),
  })
    .index("by_plan", ["planId"])
    .index("by_user", ["userId"])
    .index("by_user_and_plan", ["userId", "planId"])
    .index("by_user_and_plan_and_type", ["userId", "planId", "type"]),

  // --- Instrumentation ------------------------------------------------------
  // One row per HTTP request actually sent to the LLM Gateway, including
  // retries. Lets the seed script prove a reused run makes zero LLM calls.
  llmCalls: defineTable({
    at: v.number(),
    model: v.string(),
    schemaName: v.string(),
    /** 1 or 2 — the second row for a schemaName means the retry fired. */
    attempt: v.number(),
    /** true only when the response was received AND passed validation. */
    ok: v.boolean(),
    errorName: v.optional(v.string()),
    /** Why the attempt was rejected (transport error or validation message). */
    errorMessage: v.optional(v.string()),
  }).index("by_at", ["at"]),

  // Denormalised running total, so reading the count is O(1) rather than a
  // scan of llmCalls (Convex has no count operator).
  llmCallCounter: defineTable({
    count: v.number(),
  }),
});
