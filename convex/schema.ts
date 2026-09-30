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
  /** A partner's speaking-test goal (convex/partners.ts) — never shown as a learner's own goal. */
  v.literal("partner_test"),
);

/**
 * `goalTypeValidator` minus "partner_test" — for outputs that promise a real
 * learner goal (goals.activeGoal, home.units). A partner_test goal is never
 * `active`, so it structurally can't reach these; `lib/authz.ts`'s
 * `requireLearnerGoalType` is the runtime bridge from the wider stored type.
 */
export const learnerGoalTypeValidator = v.union(
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

/** Time passes. Mirrors PASS_DAYS in lib/passes. */
export const passTypeValidator = v.union(v.literal("week"), v.literal("month"));

/** Who issued a pass. Only "demo" can be created by a client (and only when enabled). */
export const passSourceValidator = v.union(
  v.literal("demo"),
  v.literal("razorpay"),
  v.literal("revenuecat"),
);

export const savedWordSourceValidator = v.union(v.literal("goal"), v.literal("lookup"));

// --- Payments (Razorpay) -----------------------------------------------------

/** What a payment is for. One generic table serves both. */
export const paymentPurposeValidator = v.union(v.literal("pass"), v.literal("room_booking"));

/**
 * created    order made, Checkout not completed yet.
 * authorized paid, held by Razorpay, not yet captured (room bookings: manual
 *            capture — Razorpay auto-refunds this if never captured within
 *            the account's capture window; see lib/razorpay.ts).
 * captured   money actually settles to us. Passes: reached immediately.
 * refunded   returned to the payer (an active refund, or a never-captured
 *            authorization voided by letting it expire).
 * failed     Checkout/bank declined it.
 */
export const paymentStatusValidator = v.union(
  v.literal("created"),
  v.literal("authorized"),
  v.literal("captured"),
  v.literal("refunded"),
  v.literal("failed"),
);

/** Partner payout ledger only — no real payouts move yet (see convex/partnerPayouts.ts). */
export const payoutStatusValidator = v.union(
  v.literal("earned"),
  v.literal("held"),
  v.literal("paid"),
);

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

// --- Rooms (partner-led speaking practice) ----------------------------------

export const partnerStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);

export const roomModeValidator = v.union(v.literal("now"), v.literal("later"));
export const roomMinutesValidator = v.union(v.literal(5), v.literal(10), v.literal(15));

export const roomStatusValidator = v.union(
  v.literal("requested"),
  v.literal("matched"),
  v.literal("confirmed"),
  v.literal("in_progress"),
  v.literal("completed"),
  v.literal("no_partner"),
  v.literal("no_show_partner"),
  v.literal("no_show_learner"),
  v.literal("ended_violation"),
  v.literal("cancelled"),
);

export const roomScriptRoleValidator = v.union(v.literal("learner"), v.literal("partner"));

/** `words` is the server-resolved, canonical word list a line draws on — never raw LLM text. */
export const roomScriptLineValidator = v.object({
  role: roomScriptRoleValidator,
  text: v.string(),
  /** Translation of `text` into the learner's own primaryLanguage — shown alongside the line so speaking it takes confidence, not guesswork. Unset for a manually-edited line (no LLM call) or a pre-existing script. */
  meaning: v.optional(v.string()),
  words: v.array(v.string()),
});

// --- Live room (Task B: joining, transcription, script tracking, safety) ---

export const roomSafetyFlagValidator = v.union(
  v.literal("safe"),
  v.literal("borderline"),
  v.literal("violation"),
);

export const roomTargetWordSaidValidator = v.object({
  word: v.string(),
  confidence: v.number(),
});

export const roomTurnSafetyValidator = v.object({
  /** The fast, deterministic rule-check outcome — always present. */
  ruleFlag: roomSafetyFlagValidator,
  /** Only set for a "borderline" ruleFlag, once the async LLM classification returns. */
  llmVerdict: v.optional(v.union(v.literal("safe"), v.literal("violation"))),
  llmReason: v.optional(v.string()),
});

export const roomWarningValidator = v.object({
  role: roomScriptRoleValidator,
  reason: v.string(),
  at: v.number(),
});

/** Task C: rules-first stats + one LLM feedback call, generated once per completed session — see convex/liveRoom.ts generateReport. */
export const roomReportValidator = v.object({
  totalLearnerLines: v.number(),
  linesDone: v.number(),
  targetWordsUsed: v.array(v.string()),
  longestPauseMs: v.number(),
  speakingSpeedWpm: v.number(),
  talkSharePercent: v.number(),
  stuckCount: v.number(),
  /** Words that were notYet/practising before this session and are canUse now — see applyRoomEvidence. */
  wordsMovedToCanUse: v.array(v.string()),
  /** Short LLM-written feedback, in the learner's own primaryLanguage. */
  feedback: v.string(),
  generatedAt: v.number(),
});

export const grammarStatusValidator = v.union(
  v.literal("ok"),
  v.literal("practising"),
  v.literal("not_yet"),
);

export const planModeValidator = v.union(v.literal("week"), v.literal("quick_prep"));

// --- Lab (docs/lab-design.md) -----------------------------------------------
// Built for levels "starting" and "basic" only; intermediate/confident stay
// design-only (single-sentence tap-to-choose, not free writing).

/** Live, incrementally-updated mastery. Distinct from levelResults, which is a
 * point-in-time snapshot from the level check and is never mutated again. */
export const wordStatusValidator = v.union(
  v.literal("notYet"),
  v.literal("practising"),
  v.literal("canUse"),
);

/**
 * One tap-to-choose blank: a fresh sentence around a known word or pattern,
 * with distractor options chosen deterministically (never LLM-invented).
 * `correctIndex` is never sent to the client before submission — see
 * labs.lab / labs.submit.
 */
export const labGrammarQuestionValidator = v.object({
  pattern: v.string(),
  sentence: v.string(),
  meaning: v.string(),
  options: v.array(v.string()),
  correctIndex: v.number(),
});

export const labWordBlankValidator = v.object({
  word: v.string(),
  /** Copied deterministically from goalTargets by word — never LLM-generated here. */
  pronunciationHint: v.optional(v.string()),
  sentence: v.string(),
  meaning: v.string(),
  options: v.array(v.string()),
  correctIndex: v.number(),
});

export const labAnswerValidator = v.object({
  index: v.number(),
  /** Learner also said the completed sentence aloud; matched deterministically
   * server-side against the target word/pattern (see lib/labValidate). */
  spokenTranscript: v.optional(v.string()),
});

export const labAttemptRecordValidator = v.object({
  submittedAt: v.number(),
  /** 0 = the original lab; 1 or 2 = a retry on missed items only. */
  retryRound: v.number(),
  grammarCorrect: v.array(v.boolean()),
  grammarSpokenCorrect: v.array(v.boolean()),
  storyCorrect: v.array(v.boolean()),
  storySpokenCorrect: v.array(v.boolean()),
  pass: v.boolean(),
});

export const labGenerationValidator = v.union(
  v.literal("generating"),
  v.literal("ready"),
  v.literal("failed"),
);

export const labOutcomeValidator = v.union(
  v.literal("pending"),
  v.literal("passed"),
  v.literal("not_yet"),
);

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

/**
 * Tracks in-flight / failed plan generation for a goal. There is no "ready"
 * value: once generation succeeds, `plans.savePlan` writes the plan row and
 * this row is deleted — the plan's existence IS "ready". Read by `home.units`
 * so the client can show a spinner or a "Try again" button while `plans` has
 * no row yet for that goal.
 */
export const planStatusValueValidator = v.union(v.literal("generating"), v.literal("failed"));

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
    /**
     * Forces goalTargets generation into this language instead of deriving it
     * from the caller's profile. Only set on `goalType: "partner_test"` goals
     * — a partner's test language is independent of whatever they are
     * personally learning. See goals.goalContext.
     */
    targetLanguageOverride: v.optional(targetLanguageValidator),
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

  planStatus: defineTable({
    goalId: v.id("goals"),
    userId: v.id("users"),
    status: planStatusValueValidator,
    updatedAt: v.number(),
  }).index("by_goal", ["goalId"]),

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

  // --- Payments (Razorpay): one generic table for passes AND room bookings ---
  payments: defineTable({
    userId: v.id("users"),
    purpose: paymentPurposeValidator,
    /** passId ("week"|"month") for purpose="pass"; an opaque booking id for purpose="room_booking". */
    refId: v.string(),
    /** Smallest currency subunit (paise for INR, cents for USD, ...). */
    amount: v.number(),
    currency: v.string(),
    razorpayOrderId: v.string(),
    razorpayPaymentId: v.optional(v.string()),
    status: paymentStatusValidator,
    /** Passed through to the Razorpay order's own `notes`; also where a room booking's partnerId lives until a real booking table exists. */
    notes: v.optional(v.record(v.string(), v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_razorpayOrderId", ["razorpayOrderId"])
    .index("by_razorpayPaymentId", ["razorpayPaymentId"])
    .index("by_purpose_and_refId", ["purpose", "refId"]),

  /** Ledger only (docs: "no real payouts yet") — earned when a room-booking payment captures, paid when a human marks it paid. */
  partnerPayouts: defineTable({
    partnerId: v.string(),
    paymentId: v.id("payments"),
    amount: v.number(),
    currency: v.string(),
    status: payoutStatusValidator,
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_partner", ["partnerId"])
    .index("by_payment", ["paymentId"])
    .index("by_status", ["status"]),

  // --- Rooms: partner profile, availability, bookings, scripts ---------------

  /** One row per (user, targetLanguage) — a user can be a partner in more than one language. */
  partnerProfiles: defineTable({
    userId: v.id("users"),
    targetLanguage: targetLanguageValidator,
    status: partnerStatusValidator,
    /** Set once the partner_test level check scores; approved iff >= "intermediate". */
    level: v.optional(levelValidator),
    /** The `goalType: "partner_test"` goal driving that level check. */
    testGoalId: v.optional(v.id("goals")),
    availableNow: v.boolean(),
    /** Treat as offline if this is more than 2 minutes old — see lib/rooms.ts HEARTBEAT_TIMEOUT_MS. */
    lastHeartbeatAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_and_language", ["userId", "targetLanguage"])
    .index("by_language_and_status", ["targetLanguage", "status"])
    .index("by_user", ["userId"])
    .index("by_testGoalId", ["testGoalId"]),

  /** A weekly recurring window. Concrete bookable instants are derived from this for the next 7 days — see lib/rooms.ts. */
  partnerAvailability: defineTable({
    partnerProfileId: v.id("partnerProfiles"),
    /** 0 = Sunday .. 6 = Saturday. */
    dayOfWeek: v.number(),
    /** Minutes since local midnight, in `timezone`. 0 <= startMinute < endMinute <= 1440. */
    startMinute: v.number(),
    endMinute: v.number(),
    /** IANA name, e.g. "Asia/Kolkata". */
    timezone: v.string(),
    createdAt: v.number(),
  }).index("by_partnerProfile", ["partnerProfileId"]),

  roomBookings: defineTable({
    learnerId: v.id("users"),
    targetLanguage: targetLanguageValidator,
    /** Snapshot of the learner's level at request time (own goal's latest level result). */
    learnerLevel: levelValidator,
    scenario: v.string(),
    minutes: roomMinutesValidator,
    mode: roomModeValidator,
    status: roomStatusValidator,
    partnerId: v.optional(v.id("users")),
    partnerProfileId: v.optional(v.id("partnerProfiles")),
    /** Concrete epoch ms — "now": set at request time; "later": the picked slot instant. */
    scheduledStartAt: v.optional(v.number()),
    scheduledEndAt: v.optional(v.number()),
    /** "now" mode only: when the 2-minute first-accept-wins window closes. */
    matchDeadlineAt: v.optional(v.number()),
    /** Set by rooms.recordRoomJoin — the only real signal checkNoShow has; see convex/rooms.ts. */
    learnerJoinedAt: v.optional(v.number()),
    partnerJoinedAt: v.optional(v.number()),
    paymentId: v.optional(v.id("payments")),
    // --- Live room state (Task B) — see convex/liveRoom.ts ------------------
    /** Index into the latest roomScript's `lines` of the next expected LEARNER line. Undefined = not started. */
    nextLearnerLineIndex: v.optional(v.number()),
    /** Full-script line indices already matched. */
    doneLineIndices: v.optional(v.array(v.number())),
    /** True while the learner has been silent >= STUCK_SILENCE_MS after a partner line; cleared on the next learner turn. */
    stuckCue: v.optional(v.boolean()),
    /** Count of stuck moments this session, for Task C's report. */
    stuckCount: v.optional(v.number()),
    learnerStrikes: v.optional(v.number()),
    partnerStrikes: v.optional(v.number()),
    lastWarning: v.optional(roomWarningValidator),
    /** Set only when status becomes "ended_violation". */
    violatorRole: v.optional(roomScriptRoleValidator),
    learnerRecordingStorageId: v.optional(v.id("_storage")),
    partnerRecordingStorageId: v.optional(v.id("_storage")),
    /** Task C: generated once, only once status is "completed" — see convex/liveRoom.ts generateReport. */
    report: v.optional(roomReportValidator),
    /** Written by applyRoomEvidence alongside the report — see roomReportValidator.wordsMovedToCanUse. */
    wordsMovedToCanUse: v.optional(v.array(v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_learner", ["learnerId"])
    .index("by_partner_and_status", ["partnerId", "status"])
    .index("by_partner_and_scheduledStartAt", ["partnerId", "scheduledStartAt"])
    .index("by_status", ["status"])
    .index("by_targetLanguage_and_mode_and_status", ["targetLanguage", "mode", "status"]),

  /** Versioned: v1 is LLM-generated, v2+ are free learner edits (no LLM call) — only the latest is shown. */
  roomScripts: defineTable({
    bookingId: v.id("roomBookings"),
    version: v.number(),
    lines: v.array(roomScriptLineValidator),
    generatedByLLM: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_booking", ["bookingId"])
    .index("by_booking_and_version", ["bookingId", "version"]),

  /** Joined when "now" matching times out with no partner, or "later" has no open slot. Not yet auto-matched (see report). */
  roomWaitlist: defineTable({
    learnerId: v.id("users"),
    targetLanguage: targetLanguageValidator,
    minutes: roomMinutesValidator,
    fromBookingId: v.optional(v.id("roomBookings")),
    createdAt: v.number(),
  })
    .index("by_targetLanguage", ["targetLanguage"])
    .index("by_learner", ["learnerId"]),

  /** One row per FINAL transcript turn in a live room. Speaker `role` is set from auth, never from the client — see liveRoom.saveRoomTurn. */
  roomTurns: defineTable({
    bookingId: v.id("roomBookings"),
    role: roomScriptRoleValidator,
    transcript: v.string(),
    words: v.array(transcriptWordValidator),
    startMs: v.number(),
    endMs: v.number(),
    /** Set only for a learner turn that matched the next expected script line. */
    matchedLineIndex: v.optional(v.number()),
    targetWordsSaid: v.array(roomTargetWordSaidValidator),
    safety: roomTurnSafetyValidator,
    createdAt: v.number(),
  })
    .index("by_booking", ["bookingId"])
    .index("by_booking_and_createdAt", ["bookingId", "createdAt"]),

  /** reportUser: stored for later review, never ends the room by itself. */
  roomReports: defineTable({
    bookingId: v.id("roomBookings"),
    reporterRole: roomScriptRoleValidator,
    reportedRole: roomScriptRoleValidator,
    reason: v.string(),
    createdAt: v.number(),
  }).index("by_booking", ["bookingId"]),

  // --- Access passes ----------------------------------------------------------
  // Everything after the level check requires an active pass. Renewals stack:
  // a new pass starts when the caller's current pass ends.
  passes: defineTable({
    userId: v.id("users"),
    passId: passTypeValidator,
    startsAt: v.number(),
    endsAt: v.number(),
    source: passSourceValidator,
    /** Payment-provider reference; makes webhook grants idempotent. */
    externalId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_user_and_endsAt", ["userId", "endsAt"])
    .index("by_externalId", ["externalId"]),

  // --- Lab (docs/lab-design.md): one row per (goal, day) ----------------------
  labs: defineTable({
    userId: v.id("users"),
    goalId: v.id("goals"),
    dayNo: v.number(),
    level: v.union(v.literal("starting"), v.literal("basic")),
    minutesPerDay: minutesPerDayValidator,
    generation: labGenerationValidator,
    /** [] while generation is "generating" / "failed". */
    grammar: v.array(labGrammarQuestionValidator),
    story: v.array(labWordBlankValidator),
    /** 0 = never retried, up to 2 (docs/lab-design.md section 6). */
    retriesUsed: v.number(),
    outcome: labOutcomeValidator,
    attempts: v.array(labAttemptRecordValidator),
    /** Set by `labs.submit` when outcome is "not_yet" and a retry is available; cleared once the retry is generated. */
    pendingRetryWords: v.optional(v.array(v.string())),
    pendingRetryPatterns: v.optional(v.array(v.string())),
    generatedAt: v.number(),
  })
    .index("by_goal_and_day", ["goalId", "dayNo"])
    .index("by_user", ["userId"]),

  /**
   * Live, per-goal skill state — the lab's evidence ladder writes here.
   * Distinct from levelResults (an immutable snapshot from the level check):
   * this is seeded from the latest level result the first time a word is
   * touched by a lab, then updated incrementally. `home.words` / `home.units`
   * still read the level-check snapshot; wiring them to this table is a
   * separate, not-yet-made decision (see the Lab build report).
   */
  wordProgress: defineTable({
    userId: v.id("users"),
    goalId: v.id("goals"),
    word: v.string(),
    /** lib/languages foldForMatching(word) — the lookup key. */
    normalized: v.string(),
    status: wordStatusValidator,
    /**
     * Distinct "YYYY-MM-DD" (server clock) days a `canUse` word was answered
     * wrong. A single wrong answer never demotes it — only wrong answers on 2
     * DIFFERENT days do (docs/lab-design.md open question 10).
     */
    wrongDays: v.array(v.string()),
    updatedAt: v.number(),
  })
    .index("by_goal_and_normalized", ["goalId", "normalized"])
    .index("by_user", ["userId"]),

  patternProgress: defineTable({
    userId: v.id("users"),
    goalId: v.id("goals"),
    pattern: v.string(),
    normalized: v.string(),
    status: grammarStatusValidator,
    wrongDays: v.array(v.string()),
    updatedAt: v.number(),
  })
    .index("by_goal_and_normalized", ["goalId", "normalized"])
    .index("by_user", ["userId"]),

  // --- Home: saved words + dictionary cache ----------------------------------
  savedWords: defineTable({
    userId: v.id("users"),
    targetLanguage: targetLanguageValidator,
    word: v.string(),
    /** Matching key (lib/languages matchTokens): case/umlaut/ß-insensitive. */
    normalized: v.string(),
    meaning: v.string(),
    pronunciationHint: v.optional(v.string()),
    source: savedWordSourceValidator,
    createdAt: v.number(),
  })
    .index("by_user_and_normalized", ["userId", "normalized"])
    .index("by_user", ["userId"]),

  /** Shared, validated LLM dictionary results. A hit costs no LLM call. */
  dictionary: defineTable({
    targetLanguage: targetLanguageValidator,
    primaryLanguage: knownLanguageValidator,
    normalized: v.string(),
    word: v.string(),
    meaning: v.string(),
    pronunciationHint: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_key", ["targetLanguage", "primaryLanguage", "normalized"]),

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
