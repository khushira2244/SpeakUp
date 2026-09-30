/**
 * Level-check scoring.
 *
 * ORDER IS LOAD-BEARING: deterministic pass FIRST, LLM pass SECOND, then a
 * purely deterministic combination. The LLM is only ever allowed to supply a
 * grammar status per server-supplied pattern and a prose summary. It never
 * decides which words the learner can use, and it never writes to the database.
 */

import { v, type Infer } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  genderValidator,
  grammarResultValidator,
  knownLanguageValidator,
  levelCheckStatusValidator,
  levelValidator,
  targetLanguageValidator,
} from "./schema";
import { requireOwnedLevelCheck, requireUserId } from "./lib/authz";
import { llmJson } from "./lib/llm";
import { llmRecorder } from "./llmMetrics";
import {
  GRAMMAR_FEEDBACK_JSON_SCHEMA,
  validateGrammarFeedback,
  type GrammarStatus,
} from "./lib/validate";
import {
  LANGUAGE_NAMES,
  generationLanguages,
  isKnownLanguage,
  isWrittenInScript,
  matchTokens,
  ownLanguagesByScript,
  readLanguageProfile,
  type KnownLanguage,
  type TargetLanguage,
} from "./lib/languages";

// ---------------------------------------------------------------------------
// Deterministic pass — pure functions, no LLM, no database
// ---------------------------------------------------------------------------

export const CLEAR_CONFIDENCE = 0.8;
export const UNCLEAR_CONFIDENCE = 0.5;
/** Used when a transcript matched but carried no word-level confidence data. */
export const MISSING_CONFIDENCE_DEFAULT = 0.5;

export type WordOutcome = "clear" | "unclear" | "not_yet";

/**
 * Canonical matching form: NFC, case-folded, German ß/umlauts folded (see
 * lib/languages foldForMatching), punctuation dropped, single-spaced.
 * Unicode-aware: keeps letters, digits AND combining marks, so Devanagari and
 * Telugu words survive intact.
 */
export function normalize(text: string): string {
  return matchTokens(text).join(" ");
}

export function tokenize(text: string): string[] {
  return matchTokens(text);
}

/**
 * Every [start, end) span of `tokens` that spells `phrase`. A span matches
 * when its tokens, joined WITHOUT spaces, equal the phrase's tokens joined the
 * same way. Spans always start and end on whole-token boundaries, so "test"
 * never matches inside "testing" — but:
 *   - a German compound that speech recognition split still matches
 *     ("Fremdenführer" heard as "fremden Führer" — observed live on u3-rt-pro)
 *   - a phrase that recognition fused into one token still matches
 *     ("Guten Tag" heard as "gutentag")
 */
export function findPhraseSpans(tokens: readonly string[], phrase: string): Array<[number, number]> {
  const phraseTokens = matchTokens(phrase);
  const target = phraseTokens.join("");
  if (target.length === 0) return [];
  const maxSpan = phraseTokens.length + 3;

  const spans: Array<[number, number]> = [];
  for (let start = 0; start < tokens.length; start++) {
    let joined = "";
    for (let end = start; end < tokens.length && end - start < maxSpan; end++) {
      joined += tokens[end];
      if (joined === target) spans.push([start, end + 1]);
      if (joined.length >= target.length) break;
    }
  }
  return spans;
}

/** True when `phrase` occurs in `haystack` on whole-token boundaries. */
export function containsPhrase(haystack: string, phrase: string): boolean {
  return findPhraseSpans(matchTokens(haystack), phrase).length > 0;
}

/**
 * Best available confidence for `expected` within a transcript's word list.
 * Word texts arrive with punctuation attached ("Doctor.", "Führer."), so each
 * is tokenised with the same fold as everything else. Within a matching span
 * a phrase is only as clear as its weakest word; across repeated occurrences
 * the best attempt counts.
 */
export function confidenceFor(
  expected: string,
  words: ReadonlyArray<{ text: string; confidence: number }>,
): number | null {
  const tokens: string[] = [];
  const confidences: number[] = [];
  for (const word of words) {
    for (const token of matchTokens(word.text)) {
      tokens.push(token);
      confidences.push(word.confidence);
    }
  }

  let best: number | null = null;
  for (const [start, end] of findPhraseSpans(tokens, expected)) {
    const spanConfidence = Math.min(...confidences.slice(start, end));
    best = best === null ? spanConfidence : Math.max(best, spanConfidence);
  }
  return best;
}

/** Step 1a: grade one read-aloud word attempt. */
export function gradeWordAttempt(attempt: {
  expected: string;
  transcript: string;
  words: ReadonlyArray<{ text: string; confidence: number }>;
}): { outcome: WordOutcome; confidence: number; found: boolean } {
  const found = containsPhrase(attempt.transcript, attempt.expected);
  if (!found) return { outcome: "not_yet", confidence: 0, found: false };

  const measured = confidenceFor(attempt.expected, attempt.words);
  const confidence = measured ?? MISSING_CONFIDENCE_DEFAULT;

  if (confidence >= CLEAR_CONFIDENCE) return { outcome: "clear", confidence, found };
  if (confidence >= UNCLEAR_CONFIDENCE) return { outcome: "unclear", confidence, found };
  return { outcome: "not_yet", confidence, found };
}

export type PromptAnalysis = {
  index: number;
  transcript: string;
  goalWordsUsed: string[];
  /** Words spoken in the TARGET language (en or de). */
  targetWordCount: number;
  /** The learner's own (known) languages heard in the answer, if any. */
  ownLanguagesUsed: KnownLanguage[];
  usedOwnLanguage: boolean;
  /** Base code of the detected language ("de", "hi", ...), when provided. */
  languageDetected: string | null;
};

/** "de-DE" / "de_DE" / "DE" -> "de". */
function baseLanguageCode(code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const base = code.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return base.length > 0 ? base : null;
}

/**
 * Step 1b: analyse one spoken prompt answer against the goal vocabulary.
 *
 *   - goalWordsUsed: goal words heard in the answer (German-aware matching),
 *     counted even inside a code-switched sentence — using the word is the
 *     skill being measured.
 *   - targetWordCount: Latin-script tokens (en and de are both Latin), BUT
 *     zero when a detected language says the answer was not in the target
 *     language at all (an English answer is not German practice, even though
 *     it is also Latin script).
 *   - ownLanguagesUsed: Devanagari -> hi, Telugu script -> te, plus the
 *     detected language when it is one of the learner's known languages other
 *     than the target.
 */
export function analysePromptAttempt(
  attempt: {
    index: number;
    transcript: string;
    languageDetected?: string | undefined;
  },
  goalWords: readonly string[],
  languages: {
    targetLanguage: TargetLanguage;
    knownLanguages: readonly KnownLanguage[];
  },
): PromptAnalysis {
  const goalWordsUsed = goalWords.filter((word) =>
    containsPhrase(attempt.transcript, word),
  );

  const detected = baseLanguageCode(attempt.languageDetected);
  const answeredOffTarget = detected !== null && detected !== languages.targetLanguage;

  const targetWordCount = answeredOffTarget
    ? 0
    : tokenize(attempt.transcript).filter((token) => isWrittenInScript(token, "Latin")).length;

  const ownLanguagesUsed: KnownLanguage[] = ownLanguagesByScript(attempt.transcript);
  if (
    answeredOffTarget &&
    isKnownLanguage(detected) &&
    languages.knownLanguages.includes(detected) &&
    !ownLanguagesUsed.includes(detected)
  ) {
    ownLanguagesUsed.push(detected);
  }

  return {
    index: attempt.index,
    transcript: attempt.transcript,
    goalWordsUsed,
    targetWordCount,
    ownLanguagesUsed,
    usedOwnLanguage: ownLanguagesUsed.length > 0,
    languageDetected: detected,
  };
}

export type CombinedWords = {
  canUse: string[];
  practising: string[];
  notYet: string[];
};

/**
 * Step 3: the deterministic combination rule. No LLM involvement.
 *   - used in a prompt answer            -> canUse
 *   - clear in the word test, never used -> practising
 *   - everything else                    -> notYet
 */
export function combineWordBuckets(args: {
  goalWords: readonly string[];
  clearInWordTest: ReadonlySet<string>;
  usedInPrompts: ReadonlySet<string>;
}): CombinedWords {
  const canUse: string[] = [];
  const practising: string[] = [];
  const notYet: string[] = [];

  for (const word of args.goalWords) {
    const key = normalize(word);
    if (args.usedInPrompts.has(key)) {
      canUse.push(word);
    } else if (args.clearInWordTest.has(key)) {
      practising.push(word);
    } else {
      notYet.push(word);
    }
  }
  return { canUse, practising, notYet };
}

export type Level = "starting" | "basic" | "intermediate" | "confident";

/** Step 3b: level thresholds on known/total goal-vocabulary coverage. */
export function computeLevel(knownCount: number, totalCount: number): Level {
  if (totalCount <= 0) return "starting";
  const ratio = knownCount / totalCount;
  if (ratio < 0.15) return "starting";
  if (ratio < 0.4) return "basic";
  if (ratio < 0.7) return "intermediate";
  return "confident";
}

// ---------------------------------------------------------------------------
// Internal data access
// ---------------------------------------------------------------------------

const scoringInputValidator = v.object({
  goalId: v.id("goals"),
  goalType: v.string(),
  goalText: v.string(),
  /** Languages the targets were generated in (goalTargets snapshot). */
  targetLanguage: targetLanguageValidator,
  primaryLanguage: knownLanguageValidator,
  knownLanguages: v.array(knownLanguageValidator),
  gender: genderValidator,
  goalWords: v.array(v.string()),
  patterns: v.array(v.object({ pattern: v.string(), example: v.string() })),
  wordAttempts: v.array(
    v.object({
      index: v.number(),
      expected: v.string(),
      transcript: v.string(),
      words: v.array(v.object({ text: v.string(), confidence: v.number() })),
    }),
  ),
  promptAttempts: v.array(
    v.object({
      index: v.number(),
      expected: v.string(),
      transcript: v.string(),
      languageDetected: v.union(v.string(), v.null()),
    }),
  ),
});

export const scoringInput = internalQuery({
  args: { levelCheckId: v.id("levelChecks"), userId: v.id("users") },
  returns: scoringInputValidator,
  handler: async (ctx, args) => {
    const levelCheck = await requireOwnedLevelCheck(ctx, args.levelCheckId, args.userId);
    const goal = await ctx.db.get("goals", levelCheck.goalId);
    if (goal === null) throw new Error("Goal for this level check no longer exists");
    const targets = await ctx.db
      .query("goalTargets")
      .withIndex("by_goal", (q) => q.eq("goalId", levelCheck.goalId))
      .first();
    if (targets === null) throw new Error("Goal targets for this level check are missing");
    const user = await ctx.db.get("users", args.userId);
    const profile = user === null ? null : readLanguageProfile(user);
    // Score in the languages the words were generated in, not the live profile.
    const languages = generationLanguages(targets, profile);
    const knownLanguages = profile?.knownLanguages ?? [languages.primaryLanguage];

    // Bounded: a level check has at most 7 attempt slots.
    const attempts = await ctx.db
      .query("attempts")
      .withIndex("by_level_check", (q) => q.eq("levelCheckId", args.levelCheckId))
      .take(64);

    return {
      goalId: levelCheck.goalId,
      goalType: goal.goalType,
      goalText: goal.goalText,
      targetLanguage: languages.targetLanguage,
      primaryLanguage: languages.primaryLanguage,
      knownLanguages,
      gender: user?.gender ?? ("unspecified" as const),
      goalWords: targets.words.map((w) => w.word),
      patterns: targets.patterns.map((p) => ({ pattern: p.pattern, example: p.example })),
      wordAttempts: attempts
        .filter((a) => a.kind === "word")
        .map((a) => ({
          index: a.index,
          expected: a.expected,
          transcript: a.transcript,
          words: a.words.map((w) => ({ text: w.text, confidence: w.confidence })),
        })),
      promptAttempts: attempts
        .filter((a) => a.kind === "prompt")
        .map((a) => ({
          index: a.index,
          expected: a.expected,
          transcript: a.transcript,
          languageDetected: a.languageDetected ?? null,
        })),
    };
  },
});

export const saveLevelResult = internalMutation({
  args: {
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwnedLevelCheck(ctx, args.levelCheckId, args.userId);

    const existing = await ctx.db
      .query("levelResults")
      .withIndex("by_level_check", (q) => q.eq("levelCheckId", args.levelCheckId))
      .first();

    const fields = {
      levelCheckId: args.levelCheckId,
      userId: args.userId,
      goalId: args.goalId,
      canUse: args.canUse,
      practising: args.practising,
      notYet: args.notYet,
      grammar: args.grammar,
      speakingSummary: args.speakingSummary,
      level: args.level,
      knownCount: args.knownCount,
      totalCount: args.totalCount,
      createdAt: Date.now(),
    };

    if (existing !== null) {
      await ctx.db.replace("levelResults", existing._id, fields);
    } else {
      await ctx.db.insert("levelResults", fields);
    }

    await ctx.db.patch("levelChecks", args.levelCheckId, {
      status: "done",
      error: undefined,
      finishedAt: Date.now(),
    });
    return null;
  },
});

/** Leaves the level check in a clear, queryable failure state. */
export const markLevelCheckFailed = internalMutation({
  args: {
    levelCheckId: v.id("levelChecks"),
    userId: v.id("users"),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwnedLevelCheck(ctx, args.levelCheckId, args.userId);
    await ctx.db.patch("levelChecks", args.levelCheckId, {
      status: "failed",
      error: args.error.slice(0, 1000),
      finishedAt: Date.now(),
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// LLM pass
// ---------------------------------------------------------------------------

const SCORING_SYSTEM = `You are a supportive speaking coach for SpeakUp, a language-learning app.
You are given a learner's spoken answers (already transcribed) in the language they are learning, and a fixed list of grammar patterns in that language.
Your only job is to (a) judge each supplied grammar pattern and (b) write a short encouraging summary in the learner's primary language.
You do NOT decide which vocabulary the learner knows — that has already been measured deterministically.
A strict validator checks your output, so follow the required shape exactly.`;

/**
 * Gendered phrasing is used only for Hindi, where verb agreement requires it.
 * Telugu and English summaries are always gender-neutral.
 */
export function genderGuidance(
  primaryLanguage: KnownLanguage,
  gender: "female" | "male" | "unspecified",
): string {
  if (primaryLanguage !== "hi") {
    return "Use gender-neutral phrasing throughout.";
  }
  if (gender === "female") {
    return "The summary is in Hindi and the learner is female: use feminine verb agreement (e.g. \"आप बोल सकती हैं\", \"आपने किया\" with feminine forms).";
  }
  if (gender === "male") {
    return "The summary is in Hindi and the learner is male: use masculine verb agreement (e.g. \"आप बोल सकते हैं\").";
  }
  return "The summary is in Hindi and the learner's gender is unspecified: use neutral phrasing that avoids gendered verb agreement (prefer noun phrases and \"आप ... कर सकते/सकती हैं\" style alternatives or impersonal constructions).";
}

function scoringPrompt(args: {
  goalType: string;
  goalText: string;
  targetLanguage: TargetLanguage;
  primaryLanguage: KnownLanguage;
  gender: "female" | "male" | "unspecified";
  patterns: ReadonlyArray<{ pattern: string; example: string }>;
  wordLines: readonly string[];
  promptLines: readonly string[];
}): string {
  const target = LANGUAGE_NAMES[args.targetLanguage];
  const primary = LANGUAGE_NAMES[args.primaryLanguage];
  return `Learner goal type: ${args.goalType}
Learner goal: "${args.goalText}"
Language being learned (TARGET): ${target} (${args.targetLanguage})
Learner's PRIMARY language (write the summary in this): ${primary} (${args.primaryLanguage})

Read-aloud word test (already graded deterministically — for context only):
${args.wordLines.join("\n")}

Spoken answers to the level-check prompts:
${args.promptLines.join("\n")}

${target} grammar patterns to judge (this list is fixed — judge every one, invent none):
${args.patterns.map((p, i) => `${i + 1}. "${p.pattern}" (example: ${p.example})`).join("\n")}

Return a JSON object with exactly these two fields:

"grammar": an array with one object per pattern above, in the same order. Each object:
  - "name": the pattern string, copied exactly as given.
  - "status": one of "ok" (used correctly), "practising" (attempted but shaky or incomplete), "not_yet" (not attempted or not understood).
  Base the judgement only on the spoken answers above. If an answer gives no evidence for a pattern, use "not_yet".

"speakingSummary": 2 to 3 sentences written in ${primary}${args.primaryLanguage === "en" ? "" : ` (not in ${target} and not in English)`}. You may quote short ${target} words the learner used. Be warm and concrete: say what the learner already did well and name one thing to practise next. Do not mention scores, percentages, or this JSON format. ${genderGuidance(args.primaryLanguage, args.gender)}`;
}

// ---------------------------------------------------------------------------
// scoreLevelCheck
// ---------------------------------------------------------------------------

/**
 * Scheduled by `levelCheck.finishLevelCheck`. Internal: the scheduler is the
 * only caller. On any unrecoverable failure the level check is left in status
 * "failed" with the reason, which `levelResult` surfaces to the client.
 */
export const scoreLevelCheck = internalAction({
  args: { levelCheckId: v.id("levelChecks"), userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      // Explicit annotation: same-file runQuery, see the Convex guidelines on
      // TypeScript circularity.
      const input: Infer<typeof scoringInputValidator> = await ctx.runQuery(internal.scoring.scoringInput, {
        levelCheckId: args.levelCheckId,
        userId: args.userId,
      });

      // ---- Step 1: deterministic pass -----------------------------------
      const clearInWordTest = new Set<string>();
      const wordLines: string[] = [];
      for (const attempt of input.wordAttempts) {
        const graded = gradeWordAttempt(attempt);
        if (graded.outcome === "clear") clearInWordTest.add(normalize(attempt.expected));
        wordLines.push(
          `- expected "${attempt.expected}" -> heard "${attempt.transcript}" (${graded.outcome}, confidence ${graded.confidence.toFixed(2)})`,
        );
      }
      if (wordLines.length === 0) wordLines.push("- (no word attempts recorded)");

      const usedInPrompts = new Set<string>();
      const promptLines: string[] = [];
      for (const attempt of input.promptAttempts) {
        const analysis = analysePromptAttempt(
          {
            index: attempt.index,
            transcript: attempt.transcript,
            languageDetected: attempt.languageDetected ?? undefined,
          },
          input.goalWords,
          { targetLanguage: input.targetLanguage, knownLanguages: input.knownLanguages },
        );
        for (const word of analysis.goalWordsUsed) usedInPrompts.add(normalize(word));
        const ownLanguages = analysis.ownLanguagesUsed.map((l) => LANGUAGE_NAMES[l]).join(", ");
        promptLines.push(
          `- Q: "${attempt.expected}"\n  A: "${attempt.transcript}"\n  (${LANGUAGE_NAMES[input.targetLanguage]} words used: ${analysis.targetWordCount}; goal words used: ${analysis.goalWordsUsed.join(", ") || "none"}; used own language: ${analysis.usedOwnLanguage ? ownLanguages : "no"}${analysis.languageDetected ? `; detected language: ${analysis.languageDetected}` : ""})`,
        );
      }
      if (promptLines.length === 0) promptLines.push("- (no prompt answers recorded)");

      // ---- Step 2: LLM pass (grammar + summary only) ---------------------
      const patternNames = input.patterns.map((p) => p.pattern);
      const feedback = await llmJson({
        system: SCORING_SYSTEM,
        user: scoringPrompt({
          goalType: input.goalType,
          goalText: input.goalText,
          targetLanguage: input.targetLanguage,
          primaryLanguage: input.primaryLanguage,
          gender: input.gender,
          patterns: input.patterns,
          wordLines,
          promptLines,
        }),
        schemaName: "level_result_feedback",
        schema: GRAMMAR_FEEDBACK_JSON_SCHEMA,
        validate: (raw) => validateGrammarFeedback(raw, patternNames),
        timeoutMs: 90_000,
        maxTokens: 4_000,
        recordCall: llmRecorder(ctx),
      });

      // ---- Step 3: deterministic combination -----------------------------
      const buckets = combineWordBuckets({
        goalWords: input.goalWords,
        clearInWordTest,
        usedInPrompts,
      });
      const knownCount = buckets.canUse.length + buckets.practising.length;
      const totalCount = input.goalWords.length;
      const level = computeLevel(knownCount, totalCount);

      const grammar: Array<{ name: string; status: GrammarStatus }> = feedback.grammar;

      // ---- Step 4: save ---------------------------------------------------
      await ctx.runMutation(internal.scoring.saveLevelResult, {
        levelCheckId: args.levelCheckId,
        userId: args.userId,
        goalId: input.goalId,
        canUse: buckets.canUse,
        practising: buckets.practising,
        notYet: buckets.notYet,
        grammar,
        speakingSummary: feedback.speakingSummary,
        level,
        knownCount,
        totalCount,
      });

      if (input.goalType === "partner_test") {
        // A partner's speaking test approves/rejects them; it needs no learning plan.
        await ctx.runMutation(internal.partners.applyTestResult, { goalId: input.goalId, level });
      } else {
        // The plan is generated exactly once, right after scoring succeeds.
        await ctx.scheduler.runAfter(0, internal.plans.generatePlanForGoal, {
          goalId: input.goalId,
          userId: args.userId,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(
        `scoreLevelCheck failed for levelCheck ${args.levelCheckId}: ${message}`,
      );
      await ctx.runMutation(internal.scoring.markLevelCheckFailed, {
        levelCheckId: args.levelCheckId,
        userId: args.userId,
        error: message,
      });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// levelResult
// ---------------------------------------------------------------------------

const levelResultValidator = v.object({
  status: levelCheckStatusValidator,
  /** Present only when status is "failed". */
  error: v.union(v.string(), v.null()),
  result: v.union(
    v.object({
      levelCheckId: v.id("levelChecks"),
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
    }),
    v.null(),
  ),
});

/**
 * The caller's own level-check outcome, including the "processing" and
 * "failed" states so a client can detect a failure instead of polling forever.
 */
export const levelResult = query({
  args: { levelCheckId: v.id("levelChecks") },
  returns: levelResultValidator,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const levelCheck = await requireOwnedLevelCheck(ctx, args.levelCheckId, userId);

    const result = await ctx.db
      .query("levelResults")
      .withIndex("by_level_check", (q) => q.eq("levelCheckId", args.levelCheckId))
      .first();

    return {
      status: levelCheck.status,
      error: levelCheck.error ?? null,
      result:
        result === null
          ? null
          : {
              levelCheckId: result.levelCheckId,
              goalId: result.goalId,
              canUse: result.canUse,
              practising: result.practising,
              notYet: result.notYet,
              grammar: result.grammar,
              speakingSummary: result.speakingSummary,
              level: result.level,
              knownCount: result.knownCount,
              totalCount: result.totalCount,
              createdAt: result.createdAt,
            },
    };
  },
});
