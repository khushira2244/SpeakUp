/**
 * Lab backend (docs/lab-design.md). Built for levels "starting" and "basic"
 * only — intermediate/confident (free writing) stay design-only.
 *
 * One lab per (goal, day), generated once from that day's plan content
 * (`plans.days[dayNo-1]`). Every word/pattern the LLM is allowed to reference
 * is ID-constrained (json_schema `enum`), the same fix used for the
 * plan-generation pattern-mismatch bug — the model never invents a word,
 * pattern or wrong-answer option. Distractors are picked deterministically,
 * with no LLM call at all.
 *
 * Skill state (word/pattern status) lives in `wordProgress` / `patternProgress`,
 * seeded from the latest level result the first time a lab touches an item,
 * then updated incrementally by lab submissions. `home.words` / `home.units`
 * still read the level-check snapshot directly; wiring them to this live
 * table is a separate decision (see the build report), not done here.
 */

import { ConvexError, v, type Infer } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  knownLanguageValidator,
  labAnswerValidator,
  labAttemptRecordValidator,
  labGenerationValidator,
  labGrammarQuestionValidator,
  labOutcomeValidator,
  labWordBlankValidator,
  minutesPerDayValidator,
  targetLanguageValidator,
} from "./schema";
import { invalid, notFound, requireActivePass, requireOwnedGoal, requireUserId } from "./lib/authz";
import { llmJson } from "./lib/llm";
import { llmRecorder } from "./llmMetrics";
import { wordStatuses } from "./home";
import {
  LANGUAGE_NAMES,
  foldForMatching,
  generationLanguages,
  readLanguageProfile,
  type KnownLanguage,
  type TargetLanguage,
} from "./lib/languages";
import {
  MAX_LAB_RETRIES,
  buildOptions,
  grammarQuestionsFor,
  labJsonSchema,
  labPasses,
  nextPatternStatus,
  nextWordStatus,
  pickDistractors,
  todayKey,
  transcriptContains,
  validateLabGeneration,
  type PatternStatus,
  type WordStatus,
} from "./lib/labValidate";

/** normalizeKey from plans.ts, duplicated here to keep this module dependency-light. */
function normalizeKey(text: string): string {
  return foldForMatching(text).replace(/\s+/gu, " ").trim();
}

// ---------------------------------------------------------------------------
// Reading a day's generation context
// ---------------------------------------------------------------------------

const dayWordValidator = v.object({
  word: v.string(),
  meaning: v.string(),
  pronunciationHint: v.optional(v.string()),
});
const dayPatternValidator = v.object({ pattern: v.string(), example: v.string(), meaning: v.string() });
const vocabWordValidator = v.object({ word: v.string(), meaning: v.string() });

const dayContextValidator = v.object({
  level: v.union(v.literal("starting"), v.literal("basic"), v.literal("intermediate"), v.literal("confident")),
  minutesPerDay: minutesPerDayValidator,
  targetLanguage: targetLanguageValidator,
  primaryLanguage: knownLanguageValidator,
  goalType: v.string(),
  goalText: v.string(),
  dayWords: v.array(dayWordValidator),
  dayPatterns: v.array(dayPatternValidator),
  allWords: v.array(vocabWordValidator),
  existingLabId: v.union(v.id("labs"), v.null()),
  existingGeneration: v.union(labGenerationValidator, v.null()),
});
/**
 * Explicit type for every `ctx.runQuery(internal.labs.*, ...)` result used
 * inside an action in THIS file. Without it, TS tries to infer the result
 * through `typeof labs` (how `_generated/api.d.ts` types `internal.labs.*`),
 * which is circular for a same-file caller and a same-file callee with no
 * annotation — surfacing as "implicitly has type 'any' ... referenced in its
 * own initializer" on the action itself.
 */
type DayContext = Infer<typeof dayContextValidator>;

export const dayContext = internalQuery({
  args: { goalId: v.id("goals"), userId: v.id("users"), dayNo: v.number() },
  returns: dayContextValidator,
  handler: async (ctx, args) => {
    await requireActivePass(ctx, args.userId);
    const goal = await requireOwnedGoal(ctx, args.goalId, args.userId);
    const plan = await ctx.db
      .query("plans")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();
    if (plan === null) {
      throw new ConvexError({ code: "plan_missing", message: "Generate this goal's plan before a lab." });
    }
    const day = plan.days.find((d) => d.dayNo === args.dayNo);
    if (day === undefined) {
      throw new ConvexError({ code: "day_not_found", message: `Day ${args.dayNo} is not part of this plan.` });
    }
    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .first();
    if (targets === null) {
      throw new Error("Goal targets are missing; cannot generate a lab yet");
    }
    const user = await ctx.db.get("users", args.userId);
    const languages = generationLanguages(targets, user === null ? null : readLanguageProfile(user));

    const latest = await ctx.db
      .query("levelResults")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .order("desc")
      .first();
    const result = latest !== null && latest.userId === args.userId ? latest : null;
    if (result === null) {
      throw new ConvexError({ code: "level_check_missing", message: "Finish the level check before a lab." });
    }

    const patternIndex = new Map(targets.patterns.map((p) => [normalizeKey(p.pattern), p]));
    const dayPatterns = day.patterns.map((pattern) => {
      const canonical = patternIndex.get(normalizeKey(pattern));
      return canonical ?? { pattern, example: "", meaning: "" };
    });

    const existing = await ctx.db
      .query("labs")
      .withIndex("by_goal_and_day", (q) => q.eq("goalId", args.goalId).eq("dayNo", args.dayNo))
      .first();

    return {
      level: result.level,
      minutesPerDay: plan.minutesPerDay,
      targetLanguage: languages.targetLanguage,
      primaryLanguage: languages.primaryLanguage,
      goalType: goal.goalType,
      goalText: goal.goalText,
      dayWords: day.words.map((w) => ({
        word: w.word,
        meaning: w.meaning,
        ...(w.pronunciationHint !== undefined ? { pronunciationHint: w.pronunciationHint } : {}),
      })),
      dayPatterns,
      allWords: targets.words.map((w) => ({ word: w.word, meaning: w.meaning })),
      existingLabId: existing?._id ?? null,
      existingGeneration: existing?.generation ?? null,
    };
  },
});

// ---------------------------------------------------------------------------
// Prompt + generation core (shared by a fresh lab and a retry)
// ---------------------------------------------------------------------------

const LAB_SYSTEM = `You are writing a short daily speaking-practice lab for SpeakUp, a language app.
You are given today's words and today's grammar pattern(s) in the language being learned, each with a short ID.
Your job is to write ONE fresh example sentence per item, each with exactly one blank marked "___", plus its meaning in the learner's primary language.
You must refer to a word or pattern ONLY by its ID — never by writing the word or pattern text in an "id" field.
Never write a sentence you were already given as an example; write a NEW one.
A strict validator checks your output, so follow the required shape exactly.`;

function labPrompt(args: {
  goalType: string;
  goalText: string;
  targetLanguage: TargetLanguage;
  primaryLanguage: KnownLanguage;
  words: ReadonlyArray<{ id: string; word: string; meaning: string }>;
  patterns: ReadonlyArray<{ id: string; pattern: string; example: string }>;
  grammarCount: number;
}): string {
  const target = LANGUAGE_NAMES[args.targetLanguage];
  const primary = LANGUAGE_NAMES[args.primaryLanguage];
  const sampleWordId = args.words[0]?.id ?? "w0";
  const samplePatternId = args.patterns[0]?.id ?? "p0";

  return `Learner goal: ${args.goalType} — "${args.goalText}"
Language being learned (TARGET): ${target} (${args.targetLanguage})
Learner's PRIMARY language (write meanings in this): ${primary} (${args.primaryLanguage})

Today's ${target} words, by ID. Refer to a word ONLY by its ID (e.g. "${sampleWordId}"):
${args.words.map((w) => `${w.id}: ${w.word} (${w.meaning})`).join("\n")}

Today's ${target} grammar pattern(s), by ID, with the example the learner already saw (write a DIFFERENT sentence, never this one):
${args.patterns.map((p) => `${p.id}: "${p.pattern}" (already-seen example: ${p.example})`).join("\n")}

Return a JSON object with two fields:

"grammar": an array of exactly ${args.grammarCount} object(s). Each:
  - "patternId": one of the pattern IDs above (may repeat if there is only one pattern).
  - "answerWordId": one of today's word IDs above — the word that correctly fills THIS sentence's blank (it must grammatically fit the pattern; pick whichever of today's words fits). USE A DIFFERENT answerWordId FOR EACH of the ${args.grammarCount} grammar object(s) — never the same word twice.
  - "sentence": a NEW ${target} sentence built from the pattern, with exactly one "___" where the answer word goes.
  - "meaning": the sentence's meaning in ${primary}.

"story": an array with EXACTLY ONE entry for EVERY word ID above (each word used exactly once). Each:
  - "wordId": the word's ID.
  - "sentence": a short, natural NEW ${target} sentence using that word, with exactly one "___" where the word goes.
  - "meaning": the sentence's meaning in ${primary}.

Keep every sentence short and simple — this is for an absolute beginner or elementary learner. Do not add any other fields.`;
}

type ReconciledLab = {
  grammar: Array<{ pattern: string; sentence: string; meaning: string; options: string[]; correctIndex: number }>;
  story: Array<{
    word: string;
    meaning: string;
    pronunciationHint?: string;
    sentence: string;
    options: string[];
    correctIndex: number;
  }>;
};

async function generateLabContent(
  ctx: ActionCtx,
  args: {
    goalType: string;
    goalText: string;
    targetLanguage: TargetLanguage;
    primaryLanguage: KnownLanguage;
    targetWords: ReadonlyArray<{ word: string; meaning: string; pronunciationHint?: string }>;
    targetPatterns: ReadonlyArray<{ pattern: string; example: string; meaning: string }>;
    distractorWords: ReadonlyArray<{ word: string; meaning: string }>;
    grammarCount: number;
  },
): Promise<ReconciledLab> {
  const words = args.targetWords.map((w, i) => ({ id: `w${i}`, word: w.word, meaning: w.meaning }));
  const patterns = args.targetPatterns.map((p, i) => ({ id: `p${i}`, ...p }));
  const wordIds = new Set(words.map((w) => w.id));
  const patternIds = new Set(patterns.map((p) => p.id));
  const wordById = new Map(args.targetWords.map((w, i) => [`w${i}`, w]));
  const patternById = new Map(args.targetPatterns.map((p, i) => [`p${i}`, p.pattern]));

  const raw = await llmJson({
    system: LAB_SYSTEM,
    user: labPrompt({
      goalType: args.goalType,
      goalText: args.goalText,
      targetLanguage: args.targetLanguage,
      primaryLanguage: args.primaryLanguage,
      words,
      patterns,
      grammarCount: args.grammarCount,
    }),
    schemaName: "lab",
    schema: labJsonSchema([...wordIds], [...patternIds]),
    validate: (r) =>
      validateLabGeneration(r, {
        wordIds,
        patternIds,
        grammarCount: args.grammarCount,
        wordIdsInOrder: words.map((w) => w.id),
      }),
    timeoutMs: 120_000,
    maxTokens: 8_000,
    recordCall: llmRecorder(ctx),
  });

  // Distractors: rule-based only, from the goal's own vocabulary — never the LLM.
  const grammar = raw.grammar.map((g) => {
    const answerWord = wordById.get(g.answerWordId);
    if (answerWord === undefined) throw new Error(`internal: unknown answerWordId ${g.answerWordId}`);
    const pattern = patternById.get(g.patternId);
    if (pattern === undefined) throw new Error(`internal: unknown patternId ${g.patternId}`);
    const distractors = pickDistractors(
      args.distractorWords.map((w) => ({ text: w.word, meaning: w.meaning })),
      { text: answerWord.word, meaning: answerWord.meaning },
      3,
    );
    const { options, correctIndex } = buildOptions(answerWord.word, distractors);
    return { pattern, sentence: g.sentence, meaning: g.meaning, options, correctIndex };
  });

  const story = raw.story.map((s) => {
    const canonical = wordById.get(s.wordId);
    if (canonical === undefined) throw new Error(`internal: unknown wordId ${s.wordId}`);
    const distractors = pickDistractors(
      args.distractorWords.map((w) => ({ text: w.word, meaning: w.meaning })),
      { text: canonical.word, meaning: canonical.meaning },
      3,
    );
    const { options, correctIndex } = buildOptions(canonical.word, distractors);
    return {
      word: canonical.word,
      meaning: canonical.meaning,
      ...(canonical.pronunciationHint !== undefined ? { pronunciationHint: canonical.pronunciationHint } : {}),
      sentence: s.sentence,
      options,
      correctIndex,
    };
  });

  return { grammar, story };
}

// ---------------------------------------------------------------------------
// Fresh generation
// ---------------------------------------------------------------------------

export const startGenerating = internalMutation({
  args: {
    userId: v.id("users"),
    goalId: v.id("goals"),
    dayNo: v.number(),
    level: v.union(v.literal("starting"), v.literal("basic")),
    minutesPerDay: minutesPerDayValidator,
  },
  returns: v.id("labs"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("labs")
      .withIndex("by_goal_and_day", (q) => q.eq("goalId", args.goalId).eq("dayNo", args.dayNo))
      .first();
    const fields = {
      userId: args.userId,
      goalId: args.goalId,
      dayNo: args.dayNo,
      level: args.level,
      minutesPerDay: args.minutesPerDay,
      generation: "generating" as const,
      grammar: [],
      story: [],
      retriesUsed: existing?.retriesUsed ?? 0,
      outcome: existing?.outcome ?? ("pending" as const),
      attempts: existing?.attempts ?? [],
      generatedAt: Date.now(),
    };
    if (existing !== null) {
      await ctx.db.replace("labs", existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("labs", fields);
  },
});

export const saveLabContent = internalMutation({
  args: {
    labId: v.id("labs"),
    grammar: v.array(labGrammarQuestionValidator),
    story: v.array(labWordBlankValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("labs", args.labId, {
      grammar: args.grammar,
      story: args.story,
      generation: "ready",
      generatedAt: Date.now(),
    });
    return null;
  },
});

export const markGenerationFailed = internalMutation({
  args: { labId: v.id("labs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("labs", args.labId, { generation: "failed" });
    return null;
  },
});

const generateResultValidator = v.object({ labId: v.id("labs"), generation: labGenerationValidator });

/**
 * Generates the lab for one plan day, once. Idempotent: an existing "ready"
 * lab is returned unchanged (no auto-regeneration, same rule as
 * `plans.generatePlan`); a previously "failed" attempt is retried in place.
 */
export const generateLabForDay = action({
  args: { goalId: v.id("goals"), dayNo: v.number() },
  returns: generateResultValidator,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    // requireActivePass/requireOwnedGoal need ctx.db, which an action does not
    // have — both are enforced inside dayContext (a query) instead.
    const context: DayContext = await ctx.runQuery(internal.labs.dayContext, {
      goalId: args.goalId,
      userId,
      dayNo: args.dayNo,
    });

    if (context.existingLabId !== null && context.existingGeneration === "ready") {
      return { labId: context.existingLabId, generation: "ready" as const };
    }
    if (context.level !== "starting" && context.level !== "basic") {
      throw new ConvexError({
        code: "level_not_supported",
        message: `Labs are built for "starting" and "basic" only right now (this goal is "${context.level}").`,
      });
    }

    const labId: Id<"labs"> = await ctx.runMutation(internal.labs.startGenerating, {
      userId,
      goalId: args.goalId,
      dayNo: args.dayNo,
      level: context.level,
      minutesPerDay: context.minutesPerDay,
    });

    try {
      const content = await generateLabContent(ctx, {
        goalType: context.goalType,
        goalText: context.goalText,
        targetLanguage: context.targetLanguage,
        primaryLanguage: context.primaryLanguage,
        targetWords: context.dayWords,
        targetPatterns: context.dayPatterns,
        distractorWords: context.allWords,
        grammarCount: grammarQuestionsFor(context.minutesPerDay),
      });
      await ctx.runMutation(internal.labs.saveLabContent, { labId, grammar: content.grammar, story: content.story });
      return { labId, generation: "ready" as const };
    } catch (error) {
      await ctx.runMutation(internal.labs.markGenerationFailed, { labId });
      throw error;
    }
  },
});

// ---------------------------------------------------------------------------
// Reading a lab (answers hidden until submitted)
// ---------------------------------------------------------------------------

const labViewValidator = v.object({
  generation: labGenerationValidator,
  outcome: labOutcomeValidator,
  retriesUsed: v.number(),
  retriesLeft: v.number(),
  grammar: v.array(v.object({ pattern: v.string(), sentence: v.string(), meaning: v.string(), options: v.array(v.string()) })),
  story: v.array(
    v.object({
      word: v.string(),
      meaning: v.string(),
      pronunciationHint: v.union(v.string(), v.null()),
      sentence: v.string(),
      options: v.array(v.string()),
    }),
  ),
});

async function requireOwnedLab(ctx: { db: MutationCtx["db"] }, labId: Id<"labs">, userId: Id<"users">): Promise<Doc<"labs">> {
  const lab = await ctx.db.get("labs", labId);
  if (lab === null) notFound("Lab not found");
  if (lab.userId !== userId) invalid("This lab belongs to another user");
  return lab;
}

/** The caller's lab for a plan day — `null` if it hasn't been generated yet. Never exposes the correct answer. */
export const lab = query({
  args: { goalId: v.id("goals"), dayNo: v.number() },
  returns: v.union(labViewValidator, v.null()),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireActivePass(ctx, userId);
    await requireOwnedGoal(ctx, args.goalId, userId);
    const found = await ctx.db
      .query("labs")
      .withIndex("by_goal_and_day", (q) => q.eq("goalId", args.goalId).eq("dayNo", args.dayNo))
      .first();
    if (found === null) return null;
    if (found.userId !== userId) invalid("Lab ownership mismatch");
    return {
      generation: found.generation,
      outcome: found.outcome,
      retriesUsed: found.retriesUsed,
      retriesLeft: Math.max(0, MAX_LAB_RETRIES - found.retriesUsed),
      grammar: found.grammar.map((g) => ({ pattern: g.pattern, sentence: g.sentence, meaning: g.meaning, options: g.options })),
      story: found.story.map((s) => ({
        word: s.word,
        meaning: s.meaning,
        pronunciationHint: s.pronunciationHint ?? null,
        sentence: s.sentence,
        options: s.options,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Progress (wordProgress / patternProgress): seed-on-first-touch + update
// ---------------------------------------------------------------------------

/** Exported for convex/liveRoom.ts's session report (Task C) — the same wordProgress seed-then-update logic, not room-specific. */
export async function currentWordStatus(
  ctx: MutationCtx,
  args: { userId: Id<"users">; goalId: Id<"goals">; word: string },
): Promise<{ status: WordStatus; wrongDays: string[]; existingId: Id<"wordProgress"> | null }> {
  const key = normalizeKey(args.word);
  const row = await ctx.db
    .query("wordProgress")
    .withIndex("by_goal_and_normalized", (q) => q.eq("goalId", args.goalId).eq("normalized", key))
    .first();
  if (row !== null) return { status: row.status, wrongDays: row.wrongDays, existingId: row._id };

  // Seed from the latest level result (same derivation as home.words), never touched again after this.
  const latest = await ctx.db
    .query("levelResults")
    .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
    .order("desc")
    .first();
  const result = latest !== null && latest.userId === args.userId ? latest : null;
  const seeded = wordStatuses([{ word: args.word, meaning: "" }], result)[0]!.status;
  return { status: seeded, wrongDays: [], existingId: null };
}

/** Exported for convex/liveRoom.ts's session report (Task C) — see currentWordStatus above. */
export async function writeWordStatus(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    goalId: Id<"goals">;
    word: string;
    existingId: Id<"wordProgress"> | null;
    status: WordStatus;
    wrongDays: string[];
  },
): Promise<void> {
  const fields = {
    userId: args.userId,
    goalId: args.goalId,
    word: args.word,
    normalized: normalizeKey(args.word),
    status: args.status,
    wrongDays: args.wrongDays,
    updatedAt: Date.now(),
  };
  if (args.existingId !== null) await ctx.db.patch("wordProgress", args.existingId, fields);
  else await ctx.db.insert("wordProgress", fields);
}

async function currentPatternStatus(
  ctx: MutationCtx,
  args: { userId: Id<"users">; goalId: Id<"goals">; pattern: string },
): Promise<{ status: PatternStatus; wrongDays: string[]; existingId: Id<"patternProgress"> | null }> {
  const key = normalizeKey(args.pattern);
  const row = await ctx.db
    .query("patternProgress")
    .withIndex("by_goal_and_normalized", (q) => q.eq("goalId", args.goalId).eq("normalized", key))
    .first();
  if (row !== null) return { status: row.status, wrongDays: row.wrongDays, existingId: row._id };

  const latest = await ctx.db
    .query("levelResults")
    .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
    .order("desc")
    .first();
  const result = latest !== null && latest.userId === args.userId ? latest : null;
  const found = result?.grammar.find((g) => normalizeKey(g.name) === key);
  return { status: found?.status ?? "not_yet", wrongDays: [], existingId: null };
}

async function writePatternStatus(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    goalId: Id<"goals">;
    pattern: string;
    existingId: Id<"patternProgress"> | null;
    status: PatternStatus;
    wrongDays: string[];
  },
): Promise<void> {
  const fields = {
    userId: args.userId,
    goalId: args.goalId,
    pattern: args.pattern,
    normalized: normalizeKey(args.pattern),
    status: args.status,
    wrongDays: args.wrongDays,
    updatedAt: Date.now(),
  };
  if (args.existingId !== null) await ctx.db.patch("patternProgress", args.existingId, fields);
  else await ctx.db.insert("patternProgress", fields);
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

const submitResultValidator = v.object({
  pass: v.boolean(),
  correctCount: v.number(),
  totalCount: v.number(),
  grammarCorrect: v.array(v.boolean()),
  storyCorrect: v.array(v.boolean()),
  /**
   * The correct answer word for every grammar/story item, parallel to
   * grammarCorrect/storyCorrect — the `lab` query never exposes `correctIndex`
   * (so an in-progress attempt has no answer key), but the correction screen
   * (docs/lab-design.md section 3: "the correct word is filled in") needs it
   * once the attempt is over. Story already carries its answer word in `lab`
   * itself (each blank tests exactly one fixed word); this is the only new
   * disclosure — the grammar answer word, which was never exposed anywhere.
   */
  grammarAnswerWords: v.array(v.string()),
  storyAnswerWords: v.array(v.string()),
  retriesLeft: v.number(),
  /** true when a retry lab (missed items only) is ready to be generated via `labs.generateRetry`. */
  canRetry: v.boolean(),
});

/**
 * Deterministic grading + evidence-ladder update. No LLM call — the answer key
 * (`correctIndex`) was fixed at generation time. If the lab is not passed and
 * retries remain, this records which words/patterns were missed; the caller
 * then invokes `labs.generateRetry` to build a smaller lab for just those.
 */
export const submit = mutation({
  args: {
    goalId: v.id("goals"),
    dayNo: v.number(),
    grammarAnswers: v.array(labAnswerValidator),
    storyAnswers: v.array(labAnswerValidator),
  },
  returns: submitResultValidator,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireActivePass(ctx, userId);
    await requireOwnedGoal(ctx, args.goalId, userId);

    const found = await ctx.db
      .query("labs")
      .withIndex("by_goal_and_day", (q) => q.eq("goalId", args.goalId).eq("dayNo", args.dayNo))
      .first();
    if (found === null) invalid("Generate the lab before submitting it");
    if (found.userId !== userId) invalid("Lab ownership mismatch");
    if (found.generation !== "ready") invalid("This lab is not ready yet");
    if (args.grammarAnswers.length !== found.grammar.length) {
      invalid(`Expected ${found.grammar.length} grammar answer(s), got ${args.grammarAnswers.length}`);
    }
    if (args.storyAnswers.length !== found.story.length) {
      invalid(`Expected ${found.story.length} story answer(s), got ${args.storyAnswers.length}`);
    }

    const today = todayKey(Date.now());
    const grammarCorrect: boolean[] = [];
    const grammarSpokenCorrect: boolean[] = [];
    const grammarAnswerWords: string[] = [];
    const missedPatterns = new Set<string>();
    for (let i = 0; i < found.grammar.length; i++) {
      const q = found.grammar[i]!;
      const a = args.grammarAnswers[i]!;
      const correct = a.index === q.correctIndex;
      const spoken = correct && a.spokenTranscript !== undefined && transcriptContains(a.spokenTranscript, q.pattern);
      grammarCorrect.push(correct);
      grammarSpokenCorrect.push(spoken);
      grammarAnswerWords.push(q.options[q.correctIndex] ?? "");
      if (!correct) missedPatterns.add(q.pattern);

      const current = await currentPatternStatus(ctx, { userId, goalId: args.goalId, pattern: q.pattern });
      const next = nextPatternStatus(current.status, correct, spoken, current.wrongDays, today);
      await writePatternStatus(ctx, {
        userId,
        goalId: args.goalId,
        pattern: q.pattern,
        existingId: current.existingId,
        status: next.status,
        wrongDays: next.wrongDays,
      });
    }

    const storyCorrect: boolean[] = [];
    const storySpokenCorrect: boolean[] = [];
    const storyAnswerWords: string[] = [];
    const missedWords = new Set<string>();
    for (let i = 0; i < found.story.length; i++) {
      const b = found.story[i]!;
      const a = args.storyAnswers[i]!;
      const correct = a.index === b.correctIndex;
      const spoken = correct && a.spokenTranscript !== undefined && transcriptContains(a.spokenTranscript, b.word);
      storyCorrect.push(correct);
      storySpokenCorrect.push(spoken);
      storyAnswerWords.push(b.word);
      if (!correct) missedWords.add(b.word);

      const current = await currentWordStatus(ctx, { userId, goalId: args.goalId, word: b.word });
      const next = nextWordStatus(current.status, correct, spoken, current.wrongDays, today);
      await writeWordStatus(ctx, {
        userId,
        goalId: args.goalId,
        word: b.word,
        existingId: current.existingId,
        status: next.status,
        wrongDays: next.wrongDays,
      });
    }

    const correctCount = grammarCorrect.filter(Boolean).length + storyCorrect.filter(Boolean).length;
    const totalCount = grammarCorrect.length + storyCorrect.length;
    const pass = labPasses(correctCount, totalCount);
    const retriesLeft = Math.max(0, MAX_LAB_RETRIES - found.retriesUsed);
    const canRetry = !pass && retriesLeft > 0;

    const attempt = {
      submittedAt: Date.now(),
      retryRound: found.retriesUsed,
      grammarCorrect,
      grammarSpokenCorrect,
      storyCorrect,
      storySpokenCorrect,
      pass,
    };

    await ctx.db.patch("labs", found._id, {
      outcome: pass ? "passed" : "not_yet",
      attempts: [...found.attempts, attempt],
      ...(canRetry
        ? { pendingRetryWords: [...missedWords], pendingRetryPatterns: [...missedPatterns] }
        : { pendingRetryWords: undefined, pendingRetryPatterns: undefined }),
    });

    return {
      pass,
      correctCount,
      totalCount,
      grammarCorrect,
      storyCorrect,
      grammarAnswerWords,
      storyAnswerWords,
      retriesLeft,
      canRetry,
    };
  },
});

// ---------------------------------------------------------------------------
// Retry (missed items only, max 2 per day)
// ---------------------------------------------------------------------------

const retryContextValidator = v.object({
  goalType: v.string(),
  goalText: v.string(),
  targetLanguage: targetLanguageValidator,
  primaryLanguage: knownLanguageValidator,
  minutesPerDay: minutesPerDayValidator,
  retriesUsed: v.number(),
  retryWords: v.array(dayWordValidator),
  retryPatterns: v.array(dayPatternValidator),
  allWords: v.array(vocabWordValidator),
});
type RetryContext = Infer<typeof retryContextValidator>;

export const retryContext = internalQuery({
  args: { labId: v.id("labs"), userId: v.id("users") },
  returns: retryContextValidator,
  handler: async (ctx, args) => {
    await requireActivePass(ctx, args.userId);
    const lab = await ctx.db.get("labs", args.labId);
    if (lab === null) notFound("Lab not found");
    if (lab.userId !== args.userId) invalid("Lab ownership mismatch");
    if (lab.outcome !== "not_yet" || lab.retriesUsed >= MAX_LAB_RETRIES) {
      invalid("No retry is available for this lab");
    }
    if (lab.pendingRetryWords === undefined || lab.pendingRetryPatterns === undefined) {
      invalid("Submit the lab first — a retry needs to know what was missed");
    }

    const goal = await requireOwnedGoal(ctx, lab.goalId, args.userId);
    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", lab.goalId))
      .first();
    if (targets === null) throw new Error("Goal targets are missing; cannot retry a lab");
    const user = await ctx.db.get("users", args.userId);
    const languages = generationLanguages(targets, user === null ? null : readLanguageProfile(user));

    const wordIndex = new Map(targets.words.map((w) => [normalizeKey(w.word), w]));
    const patternIndex = new Map(targets.patterns.map((p) => [normalizeKey(p.pattern), p]));
    const retryWords = lab.pendingRetryWords.map((w) => {
      const canonical = wordIndex.get(normalizeKey(w));
      return canonical
        ? {
            word: canonical.word,
            meaning: canonical.meaning,
            ...(canonical.pronunciationHint !== undefined ? { pronunciationHint: canonical.pronunciationHint } : {}),
          }
        : { word: w, meaning: "" };
    });
    const retryPatterns = lab.pendingRetryPatterns.map((p) => {
      const canonical = patternIndex.get(normalizeKey(p));
      return canonical ?? { pattern: p, example: "", meaning: "" };
    });

    return {
      goalType: goal.goalType,
      goalText: goal.goalText,
      targetLanguage: languages.targetLanguage,
      primaryLanguage: languages.primaryLanguage,
      minutesPerDay: lab.minutesPerDay,
      retriesUsed: lab.retriesUsed,
      retryWords,
      retryPatterns,
      allWords: targets.words.map((w) => ({ word: w.word, meaning: w.meaning })),
    };
  },
});

export const applyRetryContent = internalMutation({
  args: {
    labId: v.id("labs"),
    grammar: v.array(labGrammarQuestionValidator),
    story: v.array(labWordBlankValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lab = await ctx.db.get("labs", args.labId);
    if (lab === null) return null;
    await ctx.db.patch("labs", args.labId, {
      grammar: args.grammar,
      story: args.story,
      generation: "ready",
      outcome: "pending",
      retriesUsed: lab.retriesUsed + 1,
      pendingRetryWords: undefined,
      pendingRetryPatterns: undefined,
      generatedAt: Date.now(),
    });
    return null;
  },
});

export const markRetryFailed = internalMutation({
  args: { labId: v.id("labs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("labs", args.labId, { generation: "failed" });
    return null;
  },
});

const findLabResultValidator = v.union(
  v.object({
    _id: v.id("labs"),
    goalId: v.id("goals"),
    userId: v.id("users"),
    outcome: labOutcomeValidator,
    retriesUsed: v.number(),
    pendingRetryWords: v.optional(v.array(v.string())),
    pendingRetryPatterns: v.optional(v.array(v.string())),
  }),
  v.null(),
);
type FoundLab = Infer<typeof findLabResultValidator>;

export const findLab = internalQuery({
  args: { goalId: v.id("goals"), dayNo: v.number(), userId: v.id("users") },
  returns: findLabResultValidator,
  handler: async (ctx, args) => {
    const found = await ctx.db
      .query("labs")
      .withIndex("by_goal_and_day", (q) => q.eq("goalId", args.goalId).eq("dayNo", args.dayNo))
      .first();
    if (found === null) return null;
    if (found.userId !== args.userId) invalid("Lab ownership mismatch");
    return {
      _id: found._id,
      goalId: found.goalId,
      userId: found.userId,
      outcome: found.outcome,
      retriesUsed: found.retriesUsed,
      pendingRetryWords: found.pendingRetryWords,
      pendingRetryPatterns: found.pendingRetryPatterns,
    };
  },
});

type GenerateResult = Infer<typeof generateResultValidator>;

/**
 * Named + explicitly typed so `internal.labs.*`'s circular self-reference
 * (this module's own `typeof labs`) can never leave this function's return
 * type unresolved — the same reason `generateLabForDay`'s local variables are
 * annotated above.
 */
async function generateRetryHandler(
  ctx: ActionCtx,
  args: { goalId: Id<"goals">; dayNo: number },
): Promise<GenerateResult> {
  const userId = await requireUserId(ctx);
  // requireActivePass/requireOwnedGoal need ctx.db, which an action does not
  // have — both are enforced inside retryContext (a query) instead.
  const found: FoundLab = await ctx.runQuery(internal.labs.findLab, {
    goalId: args.goalId,
    dayNo: args.dayNo,
    userId,
  });
  if (found === null) invalid("Generate the lab before retrying it");

  const context: RetryContext = await ctx.runQuery(internal.labs.retryContext, { labId: found._id, userId });
  const grammarCount = Math.min(grammarQuestionsFor(context.minutesPerDay), context.retryWords.length * 2 || 1);

  try {
    const content = await generateLabContent(ctx, {
      goalType: context.goalType,
      goalText: context.goalText,
      targetLanguage: context.targetLanguage,
      primaryLanguage: context.primaryLanguage,
      targetWords: context.retryWords,
      targetPatterns: context.retryPatterns,
      distractorWords: context.allWords,
      grammarCount,
    });
    await ctx.runMutation(internal.labs.applyRetryContent, {
      labId: found._id,
      grammar: content.grammar,
      story: content.story,
    });
    return { labId: found._id, generation: "ready" as const };
  } catch (error) {
    await ctx.runMutation(internal.labs.markRetryFailed, { labId: found._id });
    throw error;
  }
}

/** Regenerates the lab covering only the words/patterns missed last attempt. Up to 2 per day. */
export const generateRetry = action({
  args: { goalId: v.id("goals"), dayNo: v.number() },
  returns: generateResultValidator,
  handler: generateRetryHandler,
});

