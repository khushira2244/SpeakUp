/**
 * Plan generation: a 7-day week, or a single-day Quick Prep when the deadline
 * is today / this week.
 *
 * The LLM only *sequences* the curriculum. Every word and every grammar
 * pattern that lands in the database is reconciled against the server-owned
 * goalTargets row first, and native-language meanings always come from the
 * server, never from this LLM call. Output that references vocabulary the goal
 * does not contain is rejected, which triggers the single retry.
 */

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  deadlineValidator,
  knownLanguageValidator,
  minutesPerDayValidator,
  planDayValidator,
  planModeValidator,
  planStatusValueValidator,
  targetLanguageValidator,
} from "./schema";
import { invalid, requireOwnedGoal, requireUserId } from "./lib/authz";
import { llmJson } from "./lib/llm";
import { llmRecorder } from "./llmMetrics";
import {
  LANGUAGE_NAMES,
  foldForMatching,
  generationLanguages,
  readLanguageProfile,
  type KnownLanguage,
  type TargetLanguage,
} from "./lib/languages";
import {
  QUICK_PREP_PATTERN_COUNT,
  QUICK_PREP_WORD_COUNT,
  ValidationError,
  WEEK_DAY_COUNT,
  planJsonSchema,
  validatePlanDays,
  wordsPerDayFor,
  type PlanMode,
  type ValidatedPlanDay,
} from "./lib/validate";

/** Deadlines that mean "there is no time for a week". */
const QUICK_PREP_DEADLINES = new Set(["today", "this_week"]);

export function modeForDeadline(deadline: string): PlanMode {
  return QUICK_PREP_DEADLINES.has(deadline) ? "quick_prep" : "week";
}

// ---------------------------------------------------------------------------
// Internal data access
// ---------------------------------------------------------------------------

const planContextValidator = v.object({
  deadline: deadlineValidator,
  goalType: v.string(),
  goalText: v.string(),
  minutesPerDay: minutesPerDayValidator,
  /** Languages the goal targets were generated in (snapshot). */
  targetLanguage: targetLanguageValidator,
  primaryLanguage: knownLanguageValidator,
  vocabulary: v.array(
    v.object({
      word: v.string(),
      meaning: v.string(),
      priority: v.number(),
      pronunciationHint: v.optional(v.string()),
    }),
  ),
  patterns: v.array(v.object({ pattern: v.string(), example: v.string() })),
  /** Deterministic priority ordering from the latest level result. */
  notYet: v.array(v.string()),
  practising: v.array(v.string()),
  canUse: v.array(v.string()),
  existingPlanId: v.union(v.id("plans"), v.null()),
});

export const planContext = internalQuery({
  args: { goalId: v.id("goals"), userId: v.id("users") },
  returns: planContextValidator,
  handler: async (ctx, args) => {
    const goal = await requireOwnedGoal(ctx, args.goalId, args.userId);
    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();
    if (targets === null) {
      throw new Error("Goal targets are missing; cannot generate a plan yet");
    }
    const user = await ctx.db.get("users", args.userId);
    const languages = generationLanguages(
      targets,
      user === null ? null : readLanguageProfile(user),
    );

    // Latest level result for this goal (indexed, newest first).
    const result = await ctx.db
      .query("levelResults")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .order("desc")
      .first();

    const existingPlan = await ctx.db
      .query("plans")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();

    return {
      deadline: goal.deadline,
      goalType: goal.goalType,
      goalText: goal.goalText,
      minutesPerDay: goal.minutesPerDay,
      targetLanguage: languages.targetLanguage,
      primaryLanguage: languages.primaryLanguage,
      vocabulary: targets.words.map((w) => ({
        word: w.word,
        meaning: w.meaning,
        priority: w.priority,
        ...(w.pronunciationHint !== undefined ? { pronunciationHint: w.pronunciationHint } : {}),
      })),
      patterns: targets.patterns.map((p) => ({
        pattern: p.pattern,
        example: p.example,
      })),
      notYet: result?.notYet ?? [],
      practising: result?.practising ?? [],
      canUse: result?.canUse ?? [],
      existingPlanId: existingPlan?._id ?? null,
    };
  },
});

export const savePlan = internalMutation({
  args: {
    goalId: v.id("goals"),
    userId: v.id("users"),
    mode: planModeValidator,
    minutesPerDay: minutesPerDayValidator,
    days: v.array(planDayValidator),
    /** Only `purchases.regenPlan` passes true, and only after a paid regen. */
    replaceExisting: v.boolean(),
  },
  returns: v.object({ planId: v.id("plans"), created: v.boolean() }),
  handler: async (ctx, args) => {
    await requireOwnedGoal(ctx, args.goalId, args.userId);
    const existing = await ctx.db
      .query("plans")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();

    if (existing !== null && !args.replaceExisting) {
      // No automatic regeneration.
      return { planId: existing._id, created: false };
    }

    const fields = {
      userId: args.userId,
      goalId: args.goalId,
      mode: args.mode,
      minutesPerDay: args.minutesPerDay,
      days: args.days,
      generatedAt: Date.now(),
    };

    if (existing !== null) {
      await ctx.db.replace("plans", existing._id, fields);
      return { planId: existing._id, created: false };
    }
    const planId = await ctx.db.insert("plans", fields);
    return { planId, created: true };
  },
});

/** Upserts the one status row for a goal (there is at most one at a time). */
export const setPlanStatus = internalMutation({
  args: { goalId: v.id("goals"), userId: v.id("users"), status: planStatusValueValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("planStatus")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();
    const fields = {
      goalId: args.goalId,
      userId: args.userId,
      status: args.status,
      updatedAt: Date.now(),
    };
    if (existing === null) await ctx.db.insert("planStatus", fields);
    else await ctx.db.replace("planStatus", existing._id, fields);
    return null;
  },
});

/** Called once a plan is actually saved: the plan's existence is "ready", so no status row is needed. */
export const clearPlanStatus = internalMutation({
  args: { goalId: v.id("goals") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("planStatus")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();
    if (existing !== null) await ctx.db.delete("planStatus", existing._id);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Deterministic reconciliation of LLM output
// ---------------------------------------------------------------------------

/** German-aware key: "Straße" and "Strasse" reconcile to the same goal word. */
function normalizeKey(text: string): string {
  return foldForMatching(text).replace(/\s+/gu, " ").trim();
}

type CanonicalWord = { word: string; meaning: string; pronunciationHint?: string };
type SavedPlanDay = {
  dayNo: number;
  title: string;
  words: CanonicalWord[];
  patterns: string[];
  practiceSummary: string;
};

/**
 * Maps each ID the model chose back to the full, server-owned word/pattern
 * object. Every ID here was already checked against `wordById` / `patternById`
 * by `validatePlanDays` (backed by the JSON schema's `enum`), so a lookup miss
 * here would mean those two disagree — treated as a validation failure rather
 * than a crash, and it triggers the LLM call's single retry same as any other
 * rejection.
 *
 * `practiceSummary` is free text the model writes in the learner's primary
 * language, so nothing here constrains its content — except this: it must
 * never contain one of this call's own ID tokens (the model is told to quote
 * the real word/pattern text instead, but occasionally echoes the ID it was
 * just given). A leaked ID would show the learner a meaningless string like
 * "id0", so it is rejected here and re-tried rather than shipped.
 */
function reconcilePlanDays(
  days: ValidatedPlanDay[],
  wordById: ReadonlyMap<string, CanonicalWord>,
  patternById: ReadonlyMap<string, string>,
): SavedPlanDay[] {
  const idLeak = new RegExp(`\\b(${[...wordById.keys(), ...patternById.keys()].join("|")})\\b`);

  return days.map((day) => {
    if (idLeak.test(day.practiceSummary)) {
      throw new ValidationError(
        `plan.days[${day.dayNo - 1}].practiceSummary: contains an internal ID instead of the actual word/pattern text. Never write "id0" / "p0" style tokens in practiceSummary.`,
      );
    }
    return reconcilePlanDay(day, wordById, patternById);
  });
}

function reconcilePlanDay(
  day: ValidatedPlanDay,
  wordById: ReadonlyMap<string, CanonicalWord>,
  patternById: ReadonlyMap<string, string>,
): SavedPlanDay {
  return {
    dayNo: day.dayNo,
    title: day.title,
    practiceSummary: day.practiceSummary,
    words: day.words.map((id) => {
      const canonical = wordById.get(id);
      if (canonical === undefined) {
        throw new ValidationError(`plan.days[${day.dayNo - 1}].words: unknown word id "${id}".`);
      }
      return canonical;
    }),
    patterns: day.patterns.map((id) => {
      const canonical = patternById.get(id);
      if (canonical === undefined) {
        throw new ValidationError(`plan.days[${day.dayNo - 1}].patterns: unknown pattern id "${id}".`);
      }
      return canonical;
    }),
  };
}

/** Deterministic study order: not-yet words first, then practising, then the rest. */
function prioritizeVocabulary(context: {
  vocabulary: ReadonlyArray<{ word: string; meaning: string; priority: number }>;
  notYet: readonly string[];
  practising: readonly string[];
}): Array<{ word: string; meaning: string }> {
  const rank = new Map<string, number>();
  for (const word of context.notYet) rank.set(normalizeKey(word), 0);
  for (const word of context.practising) rank.set(normalizeKey(word), 1);

  return [...context.vocabulary]
    .map((word, originalIndex) => ({ word, originalIndex }))
    .sort((a, b) => {
      const rankA = rank.get(normalizeKey(a.word.word)) ?? 2;
      const rankB = rank.get(normalizeKey(b.word.word)) ?? 2;
      if (rankA !== rankB) return rankA - rankB;
      if (a.word.priority !== b.word.priority) return a.word.priority - b.word.priority;
      return a.originalIndex - b.originalIndex;
    })
    .map((entry) => ({ word: entry.word.word, meaning: entry.word.meaning }));
}

// ---------------------------------------------------------------------------
// LLM prompt
// ---------------------------------------------------------------------------

const PLAN_SYSTEM = `You are a curriculum sequencer for SpeakUp, a speaking app for adult language learners.
You are given a fixed vocabulary list and a fixed list of grammar patterns, each with a short ID.
Your job is ONLY to choose IDs to arrange into a study plan and write short practice instructions in the learner's primary language.
You must not invent vocabulary or grammar patterns — every "words" and "patterns" entry you output must be one of the exact IDs supplied, never the word or pattern text itself.
A strict validator checks your output, so follow the required shape exactly.`;

function planPrompt(args: {
  mode: PlanMode;
  goalType: string;
  goalText: string;
  minutesPerDay: number;
  targetLanguage: TargetLanguage;
  primaryLanguage: KnownLanguage;
  words: ReadonlyArray<{ id: string; word: string }>;
  patterns: ReadonlyArray<{ id: string; pattern: string; example: string }>;
  hasLevelResult: boolean;
}): string {
  const target = LANGUAGE_NAMES[args.targetLanguage];
  const primary = LANGUAGE_NAMES[args.primaryLanguage];
  const wordsPerDay =
    args.mode === "quick_prep" ? QUICK_PREP_WORD_COUNT : wordsPerDayFor(args.minutesPerDay);
  const patternsPerDay = args.mode === "quick_prep" ? QUICK_PREP_PATTERN_COUNT : 1;
  const dayCount = args.mode === "quick_prep" ? 1 : WEEK_DAY_COUNT;
  const sampleWordId = args.words[0]?.id ?? "id0";
  const samplePatternId = args.patterns[0]?.id ?? "p0";

  const shape =
    args.mode === "quick_prep"
      ? `Mode: QUICK PREP. The learner's deadline is immediate, so build exactly ONE day covering only the most urgent ${target} for this goal.`
      : `Mode: WEEK. Build exactly ${WEEK_DAY_COUNT} days. Days 1-6 introduce new material; day ${WEEK_DAY_COUNT} is a REVIEW day that revisits words already used on days 1-6 (repeating earlier words on day ${WEEK_DAY_COUNT} is required, not a mistake).`;

  return `Learner goal type: ${args.goalType}
Learner goal: "${args.goalText}"
Practice time: ${args.minutesPerDay} minutes per day
Language being learned (TARGET): ${target} (${args.targetLanguage})
Learner's PRIMARY language (write titles and instructions in this): ${primary} (${args.primaryLanguage})

${shape}

Allowed ${target} vocabulary, already ordered by what this learner needs most${args.hasLevelResult ? " (their level check showed the earliest entries are the weakest)" : ""}. Refer to a word ONLY by its ID (e.g. "${sampleWordId}") — never write the word itself in your answer:
${args.words.map((w) => `${w.id}: ${w.word}`).join("\n")}

Allowed ${target} grammar patterns. Refer to a pattern ONLY by its ID (e.g. "${samplePatternId}") — never write the pattern text in your answer:
${args.patterns.map((p) => `${p.id}: "${p.pattern}" (example: ${p.example})`).join("\n")}

Return a JSON object with a single field "days": an array of exactly ${dayCount} day object(s), in order. Each day object:
  - "title": a short title for the day in ${primary}, at most 8 words, naming the real situation it prepares the learner for.
  - "words": an array of exactly ${wordsPerDay} word ID(s) from the list above (e.g. "${sampleWordId}").
  - "patterns": an array of exactly ${patternsPerDay} pattern ID(s) from the list above (e.g. "${samplePatternId}").
  - "practiceSummary": 2 to 4 sentences in ${primary} telling the learner exactly what to say out loud to practise this day's words and pattern. Quote the actual ${target} word or pattern TEXT here (e.g. "${args.words[0]?.word ?? ""}"), never an ID like "${sampleWordId}" or "${samplePatternId}" — the learner must never see an ID. Describe one concrete speaking task.

Prefer the earlier (higher-need) word IDs first — lower numbers mean higher need. Do not add any other fields.`;
}

// ---------------------------------------------------------------------------
// Core generation routine
// ---------------------------------------------------------------------------

async function runPlanGeneration(
  ctx: ActionCtx,
  args: { goalId: Id<"goals">; userId: Id<"users">; replaceExisting: boolean },
): Promise<{ planId: Id<"plans">; created: boolean; mode: PlanMode }> {
  const context = await ctx.runQuery(internal.plans.planContext, {
    goalId: args.goalId,
    userId: args.userId,
  });

  const mode = modeForDeadline(context.deadline);

  // No automatic regeneration: an existing plan short-circuits unless this is
  // the explicit, purchase-gated regen path.
  if (context.existingPlanId !== null && !args.replaceExisting) {
    return { planId: context.existingPlanId, created: false, mode };
  }

  const orderedWords = prioritizeVocabulary(context);
  const requiredWordsPerDay =
    mode === "quick_prep" ? QUICK_PREP_WORD_COUNT : wordsPerDayFor(context.minutesPerDay);
  if (orderedWords.length < requiredWordsPerDay) {
    throw new Error(
      `This goal only has ${orderedWords.length} words, but a ${mode} plan needs at least ${requiredWordsPerDay} per day.`,
    );
  }

  // Short IDs the model must choose from (see planJsonSchema) instead of
  // copying word/pattern text — the bug this replaces was the model producing
  // a near-miss pattern string that failed exact-match reconciliation.
  const vocabByKey = new Map(context.vocabulary.map((w) => [normalizeKey(w.word), w]));
  const idWords = orderedWords.map((w, i) => ({ id: `id${i}`, word: w.word }));
  const idPatterns = context.patterns.map((p, i) => ({ id: `p${i}`, ...p }));
  const wordIds = new Set(idWords.map((w) => w.id));
  const patternIds = new Set(idPatterns.map((p) => p.id));
  const wordById = new Map<string, CanonicalWord>(
    idWords.map(({ id, word }) => {
      const canonical = vocabByKey.get(normalizeKey(word));
      if (canonical === undefined) {
        // orderedWords is derived from context.vocabulary, so this is unreachable.
        throw new Error(`internal: ordered word "${word}" is missing from this goal's vocabulary`);
      }
      return [
        id,
        {
          word: canonical.word,
          meaning: canonical.meaning,
          ...(canonical.pronunciationHint !== undefined
            ? { pronunciationHint: canonical.pronunciationHint }
            : {}),
        },
      ];
    }),
  );
  const patternById = new Map(idPatterns.map((p) => [p.id, p.pattern]));

  await ctx.runMutation(internal.plans.setPlanStatus, {
    goalId: args.goalId,
    userId: args.userId,
    status: "generating",
  });

  let days: SavedPlanDay[];
  try {
    days = await llmJson({
      system: PLAN_SYSTEM,
      user: planPrompt({
        mode,
        goalType: context.goalType,
        goalText: context.goalText,
        minutesPerDay: context.minutesPerDay,
        targetLanguage: context.targetLanguage,
        primaryLanguage: context.primaryLanguage,
        words: idWords,
        patterns: idPatterns,
        hasLevelResult: context.notYet.length + context.practising.length > 0,
      }),
      schemaName: "study_plan",
      schema: planJsonSchema([...wordIds], [...patternIds]),
      // Shape + ID-membership validation, then reconciliation to full objects.
      // Either throwing rejects the attempt and triggers the single retry.
      validate: (raw) =>
        reconcilePlanDays(
          validatePlanDays(raw, { mode, minutesPerDay: context.minutesPerDay, wordIds, patternIds }),
          wordById,
          patternById,
        ),
      timeoutMs: 120_000,
      maxTokens: 12_000,
      recordCall: llmRecorder(ctx),
    });
  } catch (error) {
    await ctx.runMutation(internal.plans.setPlanStatus, {
      goalId: args.goalId,
      userId: args.userId,
      status: "failed",
    });
    throw error;
  }

  const saved: { planId: Id<"plans">; created: boolean } = await ctx.runMutation(
    internal.plans.savePlan,
    {
      goalId: args.goalId,
      userId: args.userId,
      mode,
      minutesPerDay: context.minutesPerDay,
      days,
      replaceExisting: args.replaceExisting,
    },
  );
  await ctx.runMutation(internal.plans.clearPlanStatus, { goalId: args.goalId });

  return { ...saved, mode };
}

/** Shared with `purchases.regenPlan`, which supplies its own purchase gate. */
export async function generatePlanInternal(
  ctx: ActionCtx,
  args: { goalId: Id<"goals">; userId: Id<"users">; replaceExisting: boolean },
): Promise<{ planId: Id<"plans">; created: boolean; mode: PlanMode }> {
  return await runPlanGeneration(ctx, args);
}

const generatePlanResult = v.object({
  planId: v.id("plans"),
  created: v.boolean(),
  mode: planModeValidator,
});

/**
 * Scheduled by `scoring.scoreLevelCheck` once scoring succeeds.
 * Never replaces an existing plan.
 */
export const generatePlanForGoal = internalAction({
  args: { goalId: v.id("goals"), userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await runPlanGeneration(ctx, {
        goalId: args.goalId,
        userId: args.userId,
        replaceExisting: false,
      });
    } catch (error) {
      // The level result is already saved and queryable; a plan failure must
      // not roll that back. Surface it in the logs for the client to retry via
      // the public `generatePlan` action.
      console.error(
        `generatePlanForGoal failed for goal ${args.goalId}: ${
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        }`,
      );
    }
    return null;
  },
});

/**
 * Public, caller-triggered plan generation. Idempotent: if a plan already
 * exists for this goal it is returned unchanged. Regeneration is only ever
 * possible through `purchases.regenPlan`.
 */
export const generatePlan = action({
  args: { goalId: v.id("goals") },
  returns: generatePlanResult,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    // Ownership is enforced inside planContext / savePlan.
    return await runPlanGeneration(ctx, {
      goalId: args.goalId,
      userId,
      replaceExisting: false,
    });
  },
});

// ---------------------------------------------------------------------------
// plan(goalId)
// ---------------------------------------------------------------------------

const planValidator = v.object({
  _id: v.id("plans"),
  goalId: v.id("goals"),
  mode: planModeValidator,
  minutesPerDay: minutesPerDayValidator,
  days: v.array(planDayValidator),
  generatedAt: v.number(),
});

/** The caller's plan for one of their own goals. */
export const plan = query({
  args: { goalId: v.id("goals") },
  returns: v.union(planValidator, v.null()),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedGoal(ctx, args.goalId, userId);

    const found = await ctx.db
      .query("plans")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();
    if (found === null) return null;
    if (found.userId !== userId) invalid("Plan ownership mismatch");

    return {
      _id: found._id,
      goalId: found.goalId,
      mode: found.mode,
      minutesPerDay: found.minutesPerDay,
      days: found.days,
      generatedAt: found.generatedAt,
    };
  },
});
