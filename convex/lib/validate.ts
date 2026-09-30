/**
 * Schema validation for every piece of LLM output before it is allowed
 * anywhere near a database write.
 *
 * HARD RULE: the LLM never writes learner state directly. Everything it
 * produces passes through this module first, and then through the
 * deterministic combination rules in scoring.ts / plans.ts.
 *
 * This module is intentionally dependency-free (no Convex imports; only the
 * equally pure ./languages) so it is cheap to reason about and trivially
 * testable.
 */

import {
  LANGUAGE_NAMES,
  SCRIPT_FOR_LANGUAGE,
  foldForMatching,
  isWrittenInScript,
  type KnownLanguage,
  type TargetLanguage,
} from "./languages";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * JSON Schemas sent to the LLM Gateway as `response_format.json_schema`.
 *
 * These constrain the SHAPE of the response at the gateway. They deliberately
 * avoid count constraints (`minItems` / `maxItems`), which strict structured-
 * output modes do not reliably support — exact counts, distinctness and
 * allowed-vocabulary rules are enforced by the validators below, which remain
 * authoritative and still run before any database write.
 *
 * Strict mode requires every property to appear in `required`, and
 * `additionalProperties: false` on every object.
 */

export const GOAL_TARGETS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    words: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          meaning: { type: "string" },
          pronunciationHint: { type: "string" },
          priority: { type: "integer" },
        },
        required: ["word", "meaning", "pronunciationHint", "priority"],
        additionalProperties: false,
      },
    },
    patterns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          example: { type: "string" },
          meaning: { type: "string" },
        },
        required: ["pattern", "example", "meaning"],
        additionalProperties: false,
      },
    },
    levelCheckWords: { type: "array", items: { type: "string" } },
    // Named `prompt` / `translation` for the model — telling it to put German
    // into a field called "english" invites mistakes. Stored as the legacy
    // `english` / `native` columns (see levelCheckPromptValidator).
    levelCheckPrompts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          translation: { type: "string" },
        },
        required: ["prompt", "translation"],
        additionalProperties: false,
      },
    },
  },
  required: ["words", "patterns", "levelCheckWords", "levelCheckPrompts"],
  additionalProperties: false,
};

/** Pronunciation hints for words that were generated before hints existed. */
export const HINT_BACKFILL_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    hints: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          pronunciationHint: { type: "string" },
        },
        required: ["word", "pronunciationHint"],
        additionalProperties: false,
      },
    },
  },
  required: ["hints"],
  additionalProperties: false,
};

/** Dictionary lookup. All fields are required by strict mode; they are empty when isWord is false. */
export const DICTIONARY_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    isWord: { type: "boolean" },
    word: { type: "string" },
    meaning: { type: "string" },
    pronunciationHint: { type: "string" },
  },
  required: ["isWord", "word", "meaning", "pronunciationHint"],
  additionalProperties: false,
};

export const GRAMMAR_FEEDBACK_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    grammar: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          status: { type: "string", enum: ["ok", "practising", "not_yet"] },
        },
        required: ["name", "status"],
        additionalProperties: false,
      },
    },
    speakingSummary: { type: "string" },
  },
  required: ["grammar", "speakingSummary"],
  additionalProperties: false,
};

/**
 * Words and patterns are referred to only by ID (never by copying the word or
 * pattern text): `enum` on a strict json_schema field means the gateway
 * itself rejects any value outside the supplied list, so the model cannot
 * return a near-miss like "Ich lerne Deutsch." for the pattern
 * "Ich lerne ___." the way a copy-the-string-exactly instruction allowed.
 * `validatePlanDays` below still re-checks membership itself as a second,
 * server-side line of defence.
 */
export function planJsonSchema(
  wordIds: readonly string[],
  patternIds: readonly string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      days: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            words: { type: "array", items: { type: "string", enum: [...wordIds] } },
            patterns: { type: "array", items: { type: "string", enum: [...patternIds] } },
            practiceSummary: { type: "string" },
          },
          required: ["title", "words", "patterns", "practiceSummary"],
          additionalProperties: false,
        },
      },
    },
    required: ["days"],
    additionalProperties: false,
  };
}

const MAX_TEXT = 2000;

function fail(path: string, message: string): never {
  throw new ValidationError(`${path}: ${message}`);
}

export function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

export function asNonEmptyString(
  value: unknown,
  path: string,
  maxLength: number = MAX_TEXT,
): string {
  if (typeof value !== "string") fail(path, "expected a string");
  const trimmed = value.trim();
  if (trimmed.length === 0) fail(path, "expected a non-empty string");
  if (trimmed.length > maxLength) {
    fail(path, `expected at most ${maxLength} characters, got ${trimmed.length}`);
  }
  return trimmed;
}

export function asFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "expected a finite number");
  }
  return value;
}

export function asEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(path, `expected one of ${allowed.join(" | ")}`);
  }
  return value as T;
}

export function asArrayOf<T>(
  value: unknown,
  path: string,
  bounds: { min: number; max: number },
  item: (raw: unknown, itemPath: string) => T,
): T[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  if (value.length < bounds.min || value.length > bounds.max) {
    fail(
      path,
      `expected between ${bounds.min} and ${bounds.max} entries, got ${value.length}`,
    );
  }
  return value.map((raw, i) => item(raw, `${path}[${i}]`));
}

/** Pulls the first array-valued field out of an object, trying several keys. */
function pickArray(obj: Record<string, unknown>, keys: string[], path: string): unknown {
  for (const key of keys) {
    if (Array.isArray(obj[key])) return obj[key];
  }
  fail(path, `missing array field (tried: ${keys.join(", ")})`);
}

// ---------------------------------------------------------------------------
// Goal targets (goals.generateGoalTargets)
// ---------------------------------------------------------------------------

export type ValidatedGoalWord = {
  word: string;
  meaning: string;
  priority: number;
  pronunciationHint: string;
};
export type ValidatedGoalPattern = { pattern: string; example: string; meaning: string };
/** `english` = target-language prompt, `native` = primary-language translation. */
export type ValidatedLevelCheckPrompt = { english: string; native: string };

export type GenerationLanguages = {
  targetLanguage: TargetLanguage;
  primaryLanguage: KnownLanguage;
};

const MAX_HINT_LENGTH = 200;

/**
 * Deterministic pronunciation-hint rules. A hint shows how the TARGET word
 * sounds, written in the PRIMARY language's script:
 *   - non-empty, bounded length
 *   - hi / te: must not simply repeat the target word
 *   - every letter in the primary script — Devanagari for hi, Telugu for te,
 *     Latin for en ("GOO-ten tahg"). Punctuation, spaces and combining marks
 *     are ignored; a single Latin letter in a Hindi hint is a rejection.
 */
export function validatePronunciationHint(
  rawHint: unknown,
  word: string,
  primaryLanguage: KnownLanguage,
  path: string,
): string {
  const hint = asNonEmptyString(rawHint, path, MAX_HINT_LENGTH);
  if (primaryLanguage !== "en" && foldForMatching(hint) === foldForMatching(word)) {
    fail(
      path,
      `hint for "${word}" just repeats the word; write how it sounds in ${LANGUAGE_NAMES[primaryLanguage]} script`,
    );
  }
  const script = SCRIPT_FOR_LANGUAGE[primaryLanguage];
  if (!isWrittenInScript(hint, script)) {
    fail(
      path,
      `hint "${hint}" for "${word}" must be written only in ${script} script (${LANGUAGE_NAMES[primaryLanguage]})`,
    );
  }
  return hint;
}

export type ValidatedGoalTargets = {
  words: ValidatedGoalWord[];
  patterns: ValidatedGoalPattern[];
  levelCheckWords: string[];
  levelCheckPrompts: ValidatedLevelCheckPrompt[];
};

export const GOAL_WORDS_MIN = 25;
export const GOAL_WORDS_MAX = 60;
export const GOAL_PATTERNS_MIN = 4;
export const GOAL_PATTERNS_MAX = 6;
export const LEVEL_CHECK_WORD_COUNT = 5;
export const LEVEL_CHECK_PROMPT_COUNT = 2;

export function validateGoalTargets(
  raw: unknown,
  languages: GenerationLanguages,
): ValidatedGoalTargets {
  const root = asRecord(raw, "goalTargets");

  const words = asArrayOf(
    pickArray(root, ["words", "goalWords", "vocabulary"], "goalTargets.words"),
    "goalTargets.words",
    { min: GOAL_WORDS_MIN, max: GOAL_WORDS_MAX },
    (rawWord, path) => {
      const obj = asRecord(rawWord, path);
      // Deterministic clamp: the model does not get to choose an arbitrary priority.
      const priority = Math.min(
        3,
        Math.max(1, Math.round(asFiniteNumber(obj.priority ?? 2, `${path}.priority`))),
      );
      const word = asNonEmptyString(obj.word, `${path}.word`, 120);
      // Both target languages (en, de) are written in Latin script; a word in
      // any other script means the model answered in the wrong language.
      if (!isWrittenInScript(word, "Latin")) {
        fail(
          `${path}.word`,
          `"${word}" is not written in ${LANGUAGE_NAMES[languages.targetLanguage]} (Latin script)`,
        );
      }
      return {
        word,
        meaning: asNonEmptyString(obj.meaning, `${path}.meaning`, 300),
        priority,
        pronunciationHint: validatePronunciationHint(
          obj.pronunciationHint,
          word,
          languages.primaryLanguage,
          `${path}.pronunciationHint`,
        ),
      };
    },
  );

  // Deterministic de-duplication, first occurrence wins. Uses the matching
  // fold, so German "Straße" and "Strasse" count as the same word.
  const seen = new Set<string>();
  const dedupedWords: ValidatedGoalWord[] = [];
  for (const word of words) {
    const key = foldForMatching(word.word);
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedWords.push(word);
  }
  if (dedupedWords.length < GOAL_WORDS_MIN) {
    fail(
      "goalTargets.words",
      `only ${dedupedWords.length} unique words after de-duplication, need ${GOAL_WORDS_MIN}`,
    );
  }

  const patterns = asArrayOf(
    pickArray(root, ["patterns", "grammarPatterns"], "goalTargets.patterns"),
    "goalTargets.patterns",
    { min: GOAL_PATTERNS_MIN, max: GOAL_PATTERNS_MAX },
    (rawPattern, path) => {
      const obj = asRecord(rawPattern, path);
      return {
        pattern: asNonEmptyString(obj.pattern, `${path}.pattern`, 200),
        example: asNonEmptyString(obj.example, `${path}.example`, 300),
        meaning: asNonEmptyString(obj.meaning, `${path}.meaning`, 300),
      };
    },
  );

  const levelCheckWords = asArrayOf(
    pickArray(root, ["levelCheckWords", "checkWords"], "goalTargets.levelCheckWords"),
    "goalTargets.levelCheckWords",
    { min: LEVEL_CHECK_WORD_COUNT, max: LEVEL_CHECK_WORD_COUNT },
    (rawWord, path) => asNonEmptyString(rawWord, path, 120),
  );
  const uniqueCheckWords = new Set(levelCheckWords.map((w) => foldForMatching(w)));
  if (uniqueCheckWords.size !== LEVEL_CHECK_WORD_COUNT) {
    fail("goalTargets.levelCheckWords", "expected 5 distinct words");
  }

  const levelCheckPrompts = asArrayOf(
    pickArray(root, ["levelCheckPrompts", "prompts"], "goalTargets.levelCheckPrompts"),
    "goalTargets.levelCheckPrompts",
    { min: LEVEL_CHECK_PROMPT_COUNT, max: LEVEL_CHECK_PROMPT_COUNT },
    (rawPrompt, path) => {
      const obj = asRecord(rawPrompt, path);
      // Mapped onto the legacy storage names; see levelCheckPromptValidator.
      return {
        english: asNonEmptyString(obj.prompt ?? obj.english, `${path}.prompt`, 300),
        native: asNonEmptyString(obj.translation ?? obj.native, `${path}.translation`, 300),
      };
    },
  );

  return { words: dedupedWords, patterns, levelCheckWords, levelCheckPrompts };
}

// ---------------------------------------------------------------------------
// Dictionary lookup (dictionary.lookup)
// ---------------------------------------------------------------------------

/** Sized to fit a savedWords row, so a looked-up word can always be saved. */
export const DICTIONARY_LIMITS = { word: 60, meaning: 200, hint: 120 } as const;

export type ValidatedDictionaryEntry =
  | { isWord: false }
  | { isWord: true; word: string; meaning: string; pronunciationHint: string };

/**
 * `isWord: false` is a valid answer (the input is not a real target-language
 * word) and needs no other field. Otherwise: a Latin-script canonical word
 * (en and de are both Latin), a meaning, and a hint that passes the same
 * script rules as generated vocabulary.
 */
export function validateDictionaryEntry(
  raw: unknown,
  opts: { primaryLanguage: KnownLanguage },
): ValidatedDictionaryEntry {
  const root = asRecord(raw, "dictionary");
  if (typeof root.isWord !== "boolean") fail("dictionary.isWord", "expected a boolean");
  if (!root.isWord) return { isWord: false };

  const word = asNonEmptyString(root.word, "dictionary.word", DICTIONARY_LIMITS.word);
  if (!isWrittenInScript(word, "Latin")) {
    fail("dictionary.word", `"${word}" is not in the target language's (Latin) script`);
  }
  const meaning = asNonEmptyString(root.meaning, "dictionary.meaning", DICTIONARY_LIMITS.meaning);
  const pronunciationHint = validatePronunciationHint(
    root.pronunciationHint,
    word,
    opts.primaryLanguage,
    "dictionary.pronunciationHint",
  );
  if (pronunciationHint.length > DICTIONARY_LIMITS.hint) {
    fail("dictionary.pronunciationHint", `expected at most ${DICTIONARY_LIMITS.hint} characters`);
  }
  return { isWord: true, word, meaning, pronunciationHint };
}

// ---------------------------------------------------------------------------
// Pronunciation-hint backfill (migrations.backfillPronunciationHints)
// ---------------------------------------------------------------------------

/**
 * Validates hints for exactly the requested words. Every requested word must
 * receive a valid hint (a missing one rejects the whole response, which
 * triggers the single retry); words the model adds on its own are ignored.
 * Returns hints keyed by the ORIGINAL requested spelling.
 */
export function validateHintBackfill(
  raw: unknown,
  opts: { words: readonly string[]; primaryLanguage: KnownLanguage },
): Map<string, string> {
  const root = asRecord(raw, "hintBackfill");
  const supplied = asArrayOf(
    pickArray(root, ["hints"], "hintBackfill.hints"),
    "hintBackfill.hints",
    { min: 0, max: 500 },
    (rawItem, path) => {
      const obj = asRecord(rawItem, path);
      return {
        word: asNonEmptyString(obj.word, `${path}.word`, 120),
        rawHint: obj.pronunciationHint,
        path: `${path}.pronunciationHint`,
      };
    },
  );

  const byKey = new Map<string, { rawHint: unknown; path: string }>();
  for (const item of supplied) {
    const key = foldForMatching(item.word);
    if (!byKey.has(key)) byKey.set(key, { rawHint: item.rawHint, path: item.path });
  }

  const hints = new Map<string, string>();
  for (const word of opts.words) {
    const found = byKey.get(foldForMatching(word));
    if (found === undefined) {
      fail("hintBackfill.hints", `no hint returned for "${word}"`);
    }
    hints.set(
      word,
      validatePronunciationHint(found.rawHint, word, opts.primaryLanguage, found.path),
    );
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Grammar + speaking summary (scoring.scoreLevelCheck, LLM pass)
// ---------------------------------------------------------------------------

export const GRAMMAR_STATUSES = ["ok", "practising", "not_yet"] as const;
export type GrammarStatus = (typeof GRAMMAR_STATUSES)[number];

export type ValidatedGrammarFeedback = {
  grammar: Array<{ name: string; status: GrammarStatus }>;
  speakingSummary: string;
};

/**
 * `expectedPatternNames` is the canonical, server-owned list. The LLM may only
 * supply a *status* for each; names it invents are discarded and names it omits
 * default to "not_yet". The model cannot widen the learner's grammar record.
 */
export function validateGrammarFeedback(
  raw: unknown,
  expectedPatternNames: readonly string[],
): ValidatedGrammarFeedback {
  const root = asRecord(raw, "grammarFeedback");

  const supplied = asArrayOf(
    pickArray(root, ["grammar", "patterns"], "grammarFeedback.grammar"),
    "grammarFeedback.grammar",
    { min: 0, max: 50 },
    (rawItem, path) => {
      const obj = asRecord(rawItem, path);
      return {
        name: asNonEmptyString(obj.name ?? obj.pattern, `${path}.name`, 200),
        status: asEnum(obj.status, `${path}.status`, GRAMMAR_STATUSES),
      };
    },
  );

  const byName = new Map<string, GrammarStatus>();
  for (const item of supplied) {
    byName.set(item.name.toLowerCase(), item.status);
  }

  const grammar = expectedPatternNames.map((name) => ({
    name,
    status: byName.get(name.toLowerCase()) ?? ("not_yet" as GrammarStatus),
  }));

  const speakingSummary = asNonEmptyString(
    root.speakingSummary ?? root.summary,
    "grammarFeedback.speakingSummary",
    1200,
  );

  return { grammar, speakingSummary };
}

// ---------------------------------------------------------------------------
// Plan (plans.generatePlan)
// ---------------------------------------------------------------------------

export type PlanMode = "week" | "quick_prep";

/** Words per day, keyed by the learner's chosen minutes-per-day. */
export const WORDS_PER_DAY: Record<number, number> = { 5: 3, 15: 5, 30: 7, 45: 9 };

export const QUICK_PREP_WORD_COUNT = 6;
export const QUICK_PREP_PATTERN_COUNT = 2;
export const WEEK_DAY_COUNT = 7;

export type ValidatedPlanDay = {
  dayNo: number;
  title: string;
  /**
   * IDs, not word/pattern text (see `planJsonSchema`). The caller
   * (`plans.reconcilePlanDays`) maps each ID back to the full, server-owned
   * word/pattern object; a plan word's meaning and pronunciation hint always
   * come from goalTargets, never from this LLM call.
   */
  words: string[];
  patterns: string[];
  practiceSummary: string;
};

export function wordsPerDayFor(minutesPerDay: number): number {
  const count = WORDS_PER_DAY[minutesPerDay];
  if (count === undefined) {
    fail("plan.minutesPerDay", `unsupported minutesPerDay ${minutesPerDay}`);
  }
  return count;
}

export function validatePlanDays(
  raw: unknown,
  opts: {
    mode: PlanMode;
    minutesPerDay: number;
    /** The exact word/pattern IDs offered in the prompt for this call. */
    wordIds: ReadonlySet<string>;
    patternIds: ReadonlySet<string>;
  },
): ValidatedPlanDay[] {
  const root = asRecord(raw, "plan");

  const expectedDayCount = opts.mode === "quick_prep" ? 1 : WEEK_DAY_COUNT;
  const expectedWordCount =
    opts.mode === "quick_prep"
      ? QUICK_PREP_WORD_COUNT
      : wordsPerDayFor(opts.minutesPerDay);
  const expectedPatternCount = opts.mode === "quick_prep" ? QUICK_PREP_PATTERN_COUNT : 1;

  const days = asArrayOf(
    pickArray(root, ["days", "plan", "lessons"], "plan.days"),
    "plan.days",
    { min: expectedDayCount, max: expectedDayCount },
    (rawDay, path) => {
      const obj = asRecord(rawDay, path);
      const words = asArrayOf(
        pickArray(obj, ["words", "vocabulary"], `${path}.words`),
        `${path}.words`,
        { min: expectedWordCount, max: expectedWordCount },
        (rawId, wordPath) => {
          const id = asNonEmptyString(rawId, wordPath, 20);
          if (!opts.wordIds.has(id)) {
            fail(wordPath, `"${id}" is not one of the allowed word IDs for this goal`);
          }
          return id;
        },
      );
      const patterns = asArrayOf(
        pickArray(obj, ["patterns", "grammar"], `${path}.patterns`),
        `${path}.patterns`,
        { min: expectedPatternCount, max: expectedPatternCount },
        (rawId, patternPath) => {
          const id = asNonEmptyString(rawId, patternPath, 20);
          if (!opts.patternIds.has(id)) {
            fail(patternPath, `"${id}" is not one of the allowed pattern IDs for this goal`);
          }
          return id;
        },
      );
      return {
        // dayNo is assigned deterministically below, never taken from the model.
        dayNo: 0,
        title: asNonEmptyString(obj.title, `${path}.title`, 200),
        words,
        patterns,
        practiceSummary: asNonEmptyString(
          obj.practiceSummary ?? obj.practice,
          `${path}.practiceSummary`,
          1500,
        ),
      };
    },
  );

  // Deterministic: day numbers come from position, not from the LLM.
  return days.map((day, i) => ({ ...day, dayNo: i + 1 }));
}
