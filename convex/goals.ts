/**
 * Goal selection + LLM-generated goal targets (words, grammar patterns and the
 * level-check material).
 *
 * Languages: words, patterns and level-check prompts are generated in the
 * learner's TARGET language; meanings, translations and pronunciation hints in
 * their PRIMARY language. The pair used is snapshotted onto goalTargets so
 * every later stage works in the languages the words were actually made in.
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  deadlineValidator,
  goalPatternValidator,
  goalTypeValidator,
  learnerGoalTypeValidator,
  goalWordValidator,
  knownLanguageValidator,
  levelCheckPromptValidator,
  minutesPerDayValidator,
  targetLanguageValidator,
} from "./schema";
import {
  invalid,
  loadActiveGoal,
  requireLearnerGoalType,
  requireOwnedGoal,
  requireUserId,
} from "./lib/authz";
import { llmJson } from "./lib/llm";
import { llmRecorder } from "./llmMetrics";
import {
  LANGUAGE_NAMES,
  generationLanguages,
  pronunciationHintInstruction,
  readLanguageProfile,
  type KnownLanguage,
  type TargetLanguage,
} from "./lib/languages";
import {
  GOAL_PATTERNS_MAX,
  GOAL_PATTERNS_MIN,
  GOAL_TARGETS_JSON_SCHEMA,
  GOAL_WORDS_MAX,
  GOAL_WORDS_MIN,
  validateGoalTargets,
} from "./lib/validate";

const MAX_GOAL_TEXT = 300;

// ---------------------------------------------------------------------------
// setGoal
// ---------------------------------------------------------------------------

/**
 * Replaces the caller's active goal and kicks off goal-target generation.
 * Only ever touches goals owned by the authenticated caller.
 *
 * Requires a complete language profile: there is no correct language to
 * generate vocabulary in until the learner has chosen one.
 */
export const setGoal = mutation({
  args: {
    goalType: learnerGoalTypeValidator,
    goalText: v.string(),
    deadline: deadlineValidator,
    minutesPerDay: minutesPerDayValidator,
  },
  returns: v.id("goals"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    const user = await ctx.db.get("users", userId);
    if (user === null || readLanguageProfile(user) === null) {
      invalid(
        "Choose your languages first: call users.updateProfile (knownLanguages, primaryLanguage, targetLanguage) before setGoal.",
      );
    }

    const goalText = args.goalText.trim();
    if (goalText.length === 0) invalid("goalText must not be empty");
    if (goalText.length > MAX_GOAL_TEXT) {
      invalid(`goalText must be at most ${MAX_GOAL_TEXT} characters`);
    }

    // Deactivate every currently-active goal for this user (normally one).
    const activeGoals = await ctx.db
      .query("goals")
      .withIndex("by_user_and_active", (q) => q.eq("userId", userId).eq("active", true))
      .take(50);
    for (const goal of activeGoals) {
      await ctx.db.patch("goals", goal._id, { active: false });
    }

    const goalId = await ctx.db.insert("goals", {
      userId,
      goalType: args.goalType,
      goalText,
      deadline: args.deadline,
      minutesPerDay: args.minutesPerDay,
      active: true,
      createdAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.goals.generateGoalTargets, {
      goalId,
      userId,
    });

    return goalId;
  },
});

// ---------------------------------------------------------------------------
// generateGoalTargets (scheduled)
// ---------------------------------------------------------------------------

const goalContextValidator = v.object({
  goalType: goalTypeValidator,
  goalText: v.string(),
  deadline: deadlineValidator,
  minutesPerDay: minutesPerDayValidator,
  knownLanguages: v.array(knownLanguageValidator),
  primaryLanguage: knownLanguageValidator,
  targetLanguage: targetLanguageValidator,
  alreadyGenerated: v.boolean(),
});

/** Internal: goal + language profile, with the caller's ownership re-verified. */
export const goalContext = internalQuery({
  args: { goalId: v.id("goals"), userId: v.id("users") },
  returns: goalContextValidator,
  handler: async (ctx, args) => {
    const goal = await requireOwnedGoal(ctx, args.goalId, args.userId);
    const user = await ctx.db.get("users", args.userId);
    const profile = user === null ? null : readLanguageProfile(user);
    if (profile === null) {
      throw new Error(
        `User ${args.userId} has no complete language profile; cannot generate goal targets.`,
      );
    }
    const existing = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();
    return {
      goalType: goal.goalType,
      goalText: goal.goalText,
      deadline: goal.deadline,
      minutesPerDay: goal.minutesPerDay,
      knownLanguages: profile.knownLanguages,
      primaryLanguage: profile.primaryLanguage,
      // A partner_test goal fixes its own test language, independent of what
      // the caller is personally learning (convex/partners.ts).
      targetLanguage: goal.targetLanguageOverride ?? profile.targetLanguage,
      alreadyGenerated: existing !== null,
    };
  },
});

/** Internal: persists validated goal targets. Idempotent per goal. */
export const saveGoalTargets = internalMutation({
  args: {
    goalId: v.id("goals"),
    userId: v.id("users"),
    words: v.array(goalWordValidator),
    patterns: v.array(goalPatternValidator),
    levelCheckWords: v.array(v.string()),
    levelCheckPrompts: v.array(levelCheckPromptValidator),
    targetLanguage: targetLanguageValidator,
    primaryLanguage: knownLanguageValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwnedGoal(ctx, args.goalId, args.userId);
    const existing = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();
    // No automatic regeneration: if targets exist, leave them alone.
    if (existing !== null) return null;
    await ctx.db.insert("goalTargets", {
      goalId: args.goalId,
      words: args.words,
      patterns: args.patterns,
      levelCheckWords: args.levelCheckWords,
      levelCheckPrompts: args.levelCheckPrompts,
      // Snapshot: the languages these targets were actually generated in.
      targetLanguage: args.targetLanguage,
      primaryLanguage: args.primaryLanguage,
      createdAt: Date.now(),
    });
    return null;
  },
});

const GOAL_TARGETS_SYSTEM = `You are a curriculum designer for SpeakUp, a speaking app for adult language learners.
You design the smallest set of words and sentence frames in the TARGET language that lets a learner reach ONE specific real-life goal, and you explain them in the learner's PRIMARY language.
Everything you produce is checked by a strict validator before it is used, so follow the shape and the language rules exactly.`;

function spellingInstruction(target: TargetLanguage): string {
  return target === "de"
    ? "Spell it correctly with ä, ö, ü and ß, and capitalise nouns as German requires."
    : "Use lowercase unless it is a proper noun.";
}

function goalTargetsPrompt(context: {
  goalType: string;
  goalText: string;
  deadline: string;
  minutesPerDay: number;
  knownLanguages: KnownLanguage[];
  primaryLanguage: KnownLanguage;
  targetLanguage: TargetLanguage;
}): string {
  const target = LANGUAGE_NAMES[context.targetLanguage];
  const primary = LANGUAGE_NAMES[context.primaryLanguage];
  const sameLanguage = (context.primaryLanguage as string) === context.targetLanguage;

  return `Learner goal type: ${context.goalType}
Learner goal, in their own words: "${context.goalText}"
Deadline: ${context.deadline}
Practice time available: ${context.minutesPerDay} minutes per day

TARGET language (what the learner is learning to speak): ${target} (${context.targetLanguage})
PRIMARY language (how you explain things to the learner): ${primary} (${context.primaryLanguage})
Languages the learner already speaks: ${context.knownLanguages.map((l) => LANGUAGE_NAMES[l]).join(", ")}

Produce a JSON object with exactly these four fields:

"words": an array of 40 objects (minimum ${GOAL_WORDS_MIN}, maximum ${GOAL_WORDS_MAX}). Each object:
  - "word": a ${target} word or short fixed phrase (max 3 words) the learner will actually need for this goal. ${spellingInstruction(context.targetLanguage)}
  - "meaning": the meaning, written in ${primary}.${sameLanguage ? ` Since the learner's primary language is also ${target}, give a short plain definition.` : ""}
  - "pronunciationHint": ${pronunciationHintInstruction(context.targetLanguage, context.primaryLanguage)}
  - "priority": 1 = essential, 2 = useful, 3 = nice to have.
  All words must be distinct and directly tied to the goal.

"patterns": an array of ${GOAL_PATTERNS_MIN} to ${GOAL_PATTERNS_MAX} objects. Each object:
  - "pattern": a short reusable ${target} sentence frame with ___ for the gap.
  - "example": one full ${target} sentence using the frame, relevant to the goal.
  - "meaning": what the frame is for, written in ${primary}.

"levelCheckWords": an array of exactly 5 distinct strings, copied exactly from the "word" values above. These are read aloud one at a time to check pronunciation. Pick words that are common for this goal and easy to say in isolation.

"levelCheckPrompts": an array of exactly 2 objects. Each object:
  - "prompt": a very simple spoken question in ${target}, at most 12 words, directly about the goal. A beginner must be able to answer it in one or two ${target} sentences.
  - "translation": the same question translated into ${primary}.

Keep the language simple. Do not add any other top-level fields.`;
}

/**
 * Scheduled by `setGoal`. Internal: it is only ever invoked by the scheduler,
 * never by a client. Ownership was established by `setGoal` and is re-checked
 * inside `goalContext` / `saveGoalTargets`.
 */
export const generateGoalTargets = internalAction({
  args: { goalId: v.id("goals"), userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(internal.goals.goalContext, {
      goalId: args.goalId,
      userId: args.userId,
    });

    // No automatic regeneration.
    if (context.alreadyGenerated) return null;

    const languages = {
      targetLanguage: context.targetLanguage,
      primaryLanguage: context.primaryLanguage,
    };

    // llmJson enforces: strict JSON mode, timeout, exactly one retry, and the
    // validator below (which now also checks every pronunciation hint's
    // script). Invalid output never reaches the database.
    const targets = await llmJson({
      system: GOAL_TARGETS_SYSTEM,
      user: goalTargetsPrompt(context),
      schemaName: "goal_targets",
      schema: GOAL_TARGETS_JSON_SCHEMA,
      validate: (raw) => validateGoalTargets(raw, languages),
      timeoutMs: 90_000,
      // ~40 words with meanings AND hints in the primary script, plus
      // patterns and prompts; well above the gateway's 1000-token default.
      maxTokens: 12_000,
      recordCall: llmRecorder(ctx),
    });

    await ctx.runMutation(internal.goals.saveGoalTargets, {
      goalId: args.goalId,
      userId: args.userId,
      words: targets.words,
      patterns: targets.patterns,
      levelCheckWords: targets.levelCheckWords,
      levelCheckPrompts: targets.levelCheckPrompts,
      targetLanguage: languages.targetLanguage,
      primaryLanguage: languages.primaryLanguage,
    });

    return null;
  },
});

// ---------------------------------------------------------------------------
// activeGoal
// ---------------------------------------------------------------------------

const activeGoalValidator = v.object({
  _id: v.id("goals"),
  goalType: learnerGoalTypeValidator,
  goalText: v.string(),
  deadline: deadlineValidator,
  minutesPerDay: minutesPerDayValidator,
  createdAt: v.number(),
  /** `null` until `generateGoalTargets` has finished. */
  targets: v.union(
    v.object({
      words: v.array(goalWordValidator),
      patterns: v.array(goalPatternValidator),
      levelCheckWords: v.array(v.string()),
      /** `english` = target-language prompt, `native` = primary-language translation. */
      levelCheckPrompts: v.array(levelCheckPromptValidator),
      /** The languages these targets were generated in (snapshot). */
      targetLanguage: targetLanguageValidator,
      primaryLanguage: knownLanguageValidator,
    }),
    v.null(),
  ),
  targetsReady: v.boolean(),
});

/** The caller's active goal, joined with its targets once they are ready. */
export const activeGoal = query({
  args: {},
  returns: v.union(activeGoalValidator, v.null()),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const goal = await loadActiveGoal(ctx, userId);
    if (goal === null) return null;

    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", goal._id))
      .first();

    let resolvedTargets = null;
    if (targets !== null) {
      const user = await ctx.db.get("users", userId);
      const languages = generationLanguages(
        targets,
        user === null ? null : readLanguageProfile(user),
      );
      resolvedTargets = {
        words: targets.words,
        patterns: targets.patterns,
        levelCheckWords: targets.levelCheckWords,
        levelCheckPrompts: targets.levelCheckPrompts,
        targetLanguage: languages.targetLanguage,
        primaryLanguage: languages.primaryLanguage,
      };
    }

    return {
      _id: goal._id,
      goalType: requireLearnerGoalType(goal),
      goalText: goal.goalText,
      deadline: goal.deadline,
      minutesPerDay: goal.minutesPerDay,
      createdAt: goal.createdAt,
      targets: resolvedTargets,
      targetsReady: targets !== null,
    };
  },
});
