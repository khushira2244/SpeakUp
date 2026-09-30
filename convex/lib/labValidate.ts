/**
 * Lab validation and pure rules (docs/lab-design.md), for levels "starting"
 * and "basic" only.
 *
 * Same hard rule as the rest of the backend: the LLM only writes a fresh
 * sentence around a word/pattern the server already owns. Every word ID,
 * pattern ID and "which word fills this blank" choice is constrained to an
 * enumerated allowed list (the json_schema `enum`, re-checked here) — the
 * same fix used for the plan-generation pattern-mismatch bug. Wrong-answer
 * options (distractors) are never asked of the LLM at all: they are picked
 * deterministically from the goal's own word list.
 *
 * Dependency-free except for ./languages (matching the ./validate module),
 * so the evidence-ladder and distractor rules are unit-testable without a
 * deployment.
 */

import { foldForMatching, matchTokens } from "./languages";
import {
  ValidationError,
  asArrayOf,
  asNonEmptyString,
  asRecord,
} from "./validate";

function fail(path: string, message: string): never {
  throw new ValidationError(`${path}: ${message}`);
}

const MAX_SENTENCE = 400;
const MAX_ANSWER = 60;

// ---------------------------------------------------------------------------
// Day-size rules
// ---------------------------------------------------------------------------

/** Grammar questions per day, keyed by the learner's minutes-per-day (docs/lab-design.md 2c). */
export const GRAMMAR_QUESTIONS_PER_DAY: Record<number, number> = { 5: 2, 15: 3, 30: 4, 45: 5 };

export function grammarQuestionsFor(minutesPerDay: number): number {
  const n = GRAMMAR_QUESTIONS_PER_DAY[minutesPerDay];
  if (n === undefined) fail("lab.minutesPerDay", `unsupported minutesPerDay ${minutesPerDay}`);
  return n;
}

/** docs/lab-design.md section 5 proposed "4 of 5" (80%); open question 2 (exact rule) is still unresolved upstream. */
export const LAB_PASS_RATIO = 0.8;

export function labPasses(correct: number, total: number): boolean {
  return total > 0 && correct / total >= LAB_PASS_RATIO;
}

export const MAX_LAB_RETRIES = 2;

// ---------------------------------------------------------------------------
// JSON schema (LLM Gateway strict json_schema) + prompt-side helpers
// ---------------------------------------------------------------------------

/**
 * Word IDs and pattern IDs are both drawn from the SAME per-call ID space the
 * caller builds (see labs.ts): `wN` over today's (or today's retry's) words,
 * `pN` over today's patterns. `enum` on every ID field means the gateway
 * itself rejects any value outside the allowed set.
 */
export function labJsonSchema(wordIds: readonly string[], patternIds: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      grammar: {
        type: "array",
        items: {
          type: "object",
          properties: {
            patternId: { type: "string", enum: [...patternIds] },
            // The word (from today's list) that grammatically fills this
            // pattern's blank in `sentence` — reinforces vocabulary and
            // keeps every choice ID-constrained, never invented.
            answerWordId: { type: "string", enum: [...wordIds] },
            sentence: { type: "string" },
            meaning: { type: "string" },
          },
          required: ["patternId", "answerWordId", "sentence", "meaning"],
          additionalProperties: false,
        },
      },
      story: {
        type: "array",
        items: {
          type: "object",
          properties: {
            wordId: { type: "string", enum: [...wordIds] },
            sentence: { type: "string" },
            meaning: { type: "string" },
          },
          required: ["wordId", "sentence", "meaning"],
          additionalProperties: false,
        },
      },
    },
    required: ["grammar", "story"],
    additionalProperties: false,
  };
}

export type ValidatedLabGrammar = {
  patternId: string;
  answerWordId: string;
  sentence: string;
  meaning: string;
};
export type ValidatedLabStory = { wordId: string; sentence: string; meaning: string };
export type ValidatedLab = { grammar: ValidatedLabGrammar[]; story: ValidatedLabStory[] };

/** Exactly one "___" blank marker — not zero (nothing to fill) and not more than one (ambiguous). */
function requireOneBlank(sentence: string, path: string): void {
  const count = (sentence.match(/___/g) ?? []).length;
  if (count !== 1) {
    fail(path, `expected exactly one "___" blank marker, found ${count}`);
  }
}

export function validateLabGeneration(
  raw: unknown,
  opts: {
    wordIds: ReadonlySet<string>;
    patternIds: ReadonlySet<string>;
    grammarCount: number;
    /** Story has exactly one blank per targeted word — a full bijection over wordIds. */
    wordIdsInOrder: readonly string[];
  },
): ValidatedLab {
  const root = asRecord(raw, "lab");

  const grammar = asArrayOf(
    root.grammar,
    "lab.grammar",
    { min: opts.grammarCount, max: opts.grammarCount },
    (rawItem, path) => {
      const obj = asRecord(rawItem, path);
      const patternId = asNonEmptyString(obj.patternId, `${path}.patternId`, 20);
      if (!opts.patternIds.has(patternId)) {
        fail(`${path}.patternId`, `"${patternId}" is not one of this day's allowed pattern IDs`);
      }
      const answerWordId = asNonEmptyString(obj.answerWordId, `${path}.answerWordId`, 20);
      if (!opts.wordIds.has(answerWordId)) {
        fail(`${path}.answerWordId`, `"${answerWordId}" is not one of this day's allowed word IDs`);
      }
      const sentence = asNonEmptyString(obj.sentence, `${path}.sentence`, MAX_SENTENCE);
      requireOneBlank(sentence, `${path}.sentence`);
      const meaning = asNonEmptyString(obj.meaning, `${path}.meaning`, MAX_SENTENCE);
      return { patternId, answerWordId, sentence, meaning };
    },
  );
  // Every day-size combination has at least as many words as grammar questions
  // (see GRAMMAR_QUESTIONS_PER_DAY vs WORDS_PER_DAY in plans.ts), so requiring a
  // distinct answerWordId per question is always achievable, and it's what
  // actually matters (each question drills a different word). This is
  // deliberately NOT a check on sentence text: a short pattern like
  // "Mein ___ tut weh" leaves almost no room to vary the visible sentence at
  // all (the answer word never appears in the text — "___" always does), so a
  // strict text-uniqueness rule was unsatisfiable for some real patterns and
  // is not required by the design.
  const seenAnswerWords = new Set<string>();
  for (const g of grammar) {
    if (seenAnswerWords.has(g.answerWordId)) {
      fail(
        "lab.grammar",
        `answerWordId "${g.answerWordId}" reused — each grammar question must use a different word from today's list`,
      );
    }
    seenAnswerWords.add(g.answerWordId);
  }

  const story = asArrayOf(
    root.story,
    "lab.story",
    { min: opts.wordIdsInOrder.length, max: opts.wordIdsInOrder.length },
    (rawItem, path) => {
      const obj = asRecord(rawItem, path);
      const wordId = asNonEmptyString(obj.wordId, `${path}.wordId`, 20);
      if (!opts.wordIds.has(wordId)) {
        fail(`${path}.wordId`, `"${wordId}" is not one of this day's allowed word IDs`);
      }
      const sentence = asNonEmptyString(obj.sentence, `${path}.sentence`, MAX_SENTENCE);
      requireOneBlank(sentence, `${path}.sentence`);
      const meaning = asNonEmptyString(obj.meaning, `${path}.meaning`, MAX_SENTENCE);
      return { wordId, sentence, meaning };
    },
  );
  // Story is one blank PER today's word: every id must appear, exactly once each.
  const storyIds = story.map((s) => s.wordId);
  const expected = [...opts.wordIdsInOrder].sort();
  const actual = [...storyIds].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    fail(
      "lab.story",
      `expected exactly one blank for each of today's words (${expected.join(", ")}), got (${actual.join(", ")})`,
    );
  }

  return { grammar, story };
}

// ---------------------------------------------------------------------------
// Distractors — rule-based, no LLM (docs/lab-design.md 2b/2c)
// ---------------------------------------------------------------------------

/** Classic edit distance; short words only (goal vocabulary), so no need to bound it. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j - 1]!, dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

export type DistractorCandidate = { text: string; meaning?: string };

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Wrong options for a word bank. Excludes: the answer itself, same meaning,
 * same first 4 letters, or edit distance <= 2 from the answer (all folded —
 * case/umlaut/ß-insensitive). Falls back to "just not the exact same word" if
 * the strict rule can't fill `count` (a small goal vocabulary near the
 * answer), so generation never fails purely for lack of distractors.
 */
export function pickDistractors(
  pool: readonly DistractorCandidate[],
  answer: DistractorCandidate,
  count: number,
  rand: () => number = Math.random,
): string[] {
  const answerKey = foldForMatching(answer.text);
  const answerMeaning = answer.meaning !== undefined ? foldForMatching(answer.meaning) : null;

  const notTheAnswer = pool.filter((c) => foldForMatching(c.text) !== answerKey);

  const strict = notTheAnswer.filter((c) => {
    const key = foldForMatching(c.text);
    if (key.length >= 4 && answerKey.length >= 4 && key.slice(0, 4) === answerKey.slice(0, 4)) {
      return false;
    }
    if (editDistance(key, answerKey) <= 2) return false;
    if (answerMeaning !== null && c.meaning !== undefined && foldForMatching(c.meaning) === answerMeaning) {
      return false;
    }
    return true;
  });

  const dedupe = (list: readonly DistractorCandidate[]): DistractorCandidate[] => {
    const seen = new Set<string>();
    const out: DistractorCandidate[] = [];
    for (const c of list) {
      const key = foldForMatching(c.text);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  };

  const chosen = shuffle(dedupe(strict), rand)
    .slice(0, count)
    .map((c) => c.text);
  if (chosen.length >= count) return chosen;

  // Fallback: relax to "not the exact same word", still no repeats.
  const chosenKeys = new Set(chosen.map((t) => foldForMatching(t)));
  for (const c of shuffle(dedupe(notTheAnswer), rand)) {
    if (chosen.length >= count) break;
    const key = foldForMatching(c.text);
    if (chosenKeys.has(key)) continue;
    chosenKeys.add(key);
    chosen.push(c.text);
  }
  return chosen;
}

/** Shuffles the answer into the distractors and reports where it landed. */
export function buildOptions(
  answer: string,
  distractors: readonly string[],
  rand: () => number = Math.random,
): { options: string[]; correctIndex: number } {
  const options = shuffle([answer, ...distractors], rand);
  return { options, correctIndex: options.indexOf(answer) };
}

// ---------------------------------------------------------------------------
// Spoken-evidence matching (server-side; the client only supplies a transcript)
// ---------------------------------------------------------------------------

/** True when `transcript` contains `target` as a contiguous run of tokens (word-boundary safe, German-aware). */
export function transcriptContains(transcript: string, target: string): boolean {
  const heard = matchTokens(transcript);
  const words = matchTokens(target);
  if (words.length === 0) return false;
  for (let i = 0; i + words.length <= heard.length; i++) {
    if (words.every((w, j) => heard[i + j] === w)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Evidence ladder + the 2-different-days demotion rule
// ---------------------------------------------------------------------------

type Tier = 0 | 1 | 2;

/**
 * One correct tap can only ever reach tier 1 ("recognizes it" — practising /
 * ok). Only a spoken-confirmed correct answer reaches tier 2 (can_use / ok
 * with production evidence). A wrong answer never demotes on the spot; a
 * tier-2 item demotes to tier 1 only after wrong answers on 2 DIFFERENT days
 * (docs/lab-design.md open question 10's resolution).
 */
function nextTier(
  current: Tier,
  correct: boolean,
  spokenConfirmed: boolean,
  wrongDays: readonly string[],
  today: string,
): { tier: Tier; wrongDays: string[] } {
  if (!correct) {
    if (current === 2) {
      const days = wrongDays.includes(today) ? [...wrongDays] : [...wrongDays, today];
      if (days.length >= 2) return { tier: 1, wrongDays: [] };
      return { tier: 2, wrongDays: days };
    }
    return { tier: current, wrongDays: [...wrongDays] };
  }
  if (spokenConfirmed) return { tier: 2, wrongDays: [] };
  return { tier: Math.max(current, 1) as Tier, wrongDays: [...wrongDays] };
}

export type WordStatus = "notYet" | "practising" | "canUse";
export type PatternStatus = "not_yet" | "practising" | "ok";

const WORD_TIER: Record<WordStatus, Tier> = { notYet: 0, practising: 1, canUse: 2 };
const TIER_WORD: Record<Tier, WordStatus> = { 0: "notYet", 1: "practising", 2: "canUse" };
const PATTERN_TIER: Record<PatternStatus, Tier> = { not_yet: 0, practising: 1, ok: 2 };
const TIER_PATTERN: Record<Tier, PatternStatus> = { 0: "not_yet", 1: "practising", 2: "ok" };

export function nextWordStatus(
  current: WordStatus,
  correct: boolean,
  spokenConfirmed: boolean,
  wrongDays: readonly string[],
  today: string,
): { status: WordStatus; wrongDays: string[] } {
  const next = nextTier(WORD_TIER[current], correct, spokenConfirmed, wrongDays, today);
  return { status: TIER_WORD[next.tier], wrongDays: next.wrongDays };
}

export function nextPatternStatus(
  current: PatternStatus,
  correct: boolean,
  spokenConfirmed: boolean,
  wrongDays: readonly string[],
  today: string,
): { status: PatternStatus; wrongDays: string[] } {
  const next = nextTier(PATTERN_TIER[current], correct, spokenConfirmed, wrongDays, today);
  return { status: TIER_PATTERN[next.tier], wrongDays: next.wrongDays };
}

/** Server-clock UTC day key, used for the 2-different-days demotion rule. */
export function todayKey(now: number): string {
  const iso = new Date(now).toISOString();
  return iso.slice(0, 10);
}
