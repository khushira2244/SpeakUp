/**
 * Verification that does NOT require LLM Gateway access.
 *
 *   npm run verify
 *
 * Part A (offline): the deterministic rules — word grading thresholds, the
 *   canUse/practising/notYet combination, level bands, purchase unlock rules,
 *   the today-card day selector, and the LLM-output validators (including that
 *   they REJECT malformed output).
 * Part B (live): the real Convex dev deployment — Convex Auth, the language
 *   profile rule, getStreamConfig routing + auth, the migration's result shape,
 *   goal creation, per-document ownership isolation, and the queryable
 *   not-ready / failure states. Uses fixed, reused accounts
 *   (verify-a/b/c@speakup.dev), so it spends one goal generation on its very
 *   first run and no LLM calls after that.
 *
 * `npm run seed` covers the remaining LLM-dependent stages end to end.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

import {
  combineWordBuckets,
  computeLevel,
  confidenceFor,
  containsPhrase,
  genderGuidance,
  gradeWordAttempt,
  normalize,
  analysePromptAttempt,
} from "../convex/scoring";
import { computeDayAccess, priceFor } from "../convex/purchases";
import { currentDayNo } from "../convex/home";
import {
  validateGoalTargets,
  validateHintBackfill,
  validatePlanDays,
  validateGrammarFeedback,
  validatePronunciationHint,
  wordsPerDayFor,
} from "../convex/lib/validate";
import {
  foldForMatching,
  isWrittenInScript,
  normalizeLanguageProfile,
  ownLanguagesByScript,
  planLegacyLanguageBackfill,
  streamRouteFor,
} from "../convex/lib/languages";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

/** Asserts that `fn` throws — used to prove validators reject bad input. */
function rejects(name: string, fn: () => unknown): void {
  let threw = false;
  let message = "";
  try {
    fn();
  } catch (error) {
    threw = true;
    message = error instanceof Error ? error.message : String(error);
  }
  check(name, threw, threw ? message.slice(0, 90) : "did NOT throw");
}

// ---------------------------------------------------------------------------
// Part A — deterministic rules, no network
// ---------------------------------------------------------------------------

function partA(): void {
  console.log("PART A — deterministic rules (offline)");

  section("Text normalization");
  check("punctuation stripped and lowercased", normalize("  Hello, WORLD!! ") === "hello world");
  check("phrase matched on token boundaries", containsPhrase("i need a blood test today", "blood test"));
  check(
    "substring inside a word does NOT match",
    !containsPhrase("i went to the testing centre", "test"),
  );
  check(
    "Devanagari script → own language hi",
    ownLanguagesByScript("मुझे बुखार है").join(",") === "hi",
  );
  check(
    "Telugu script → own language te",
    ownLanguagesByScript("నాకు జ్వరం ఉంది").join(",") === "te",
  );
  check(
    "Latin script (en or de) → no own-language evidence from script",
    ownLanguagesByScript("ich habe Fieber").length === 0,
  );
  check(
    "Devanagari combining marks survive tokenising",
    normalize("मुझे बुखार है") === "मुझे बुखार है",
    normalize("मुझे बुखार है"),
  );

  section("Word-test grading thresholds (0.8 clear / 0.5 unclear)");
  const clear = gradeWordAttempt({
    expected: "fever",
    transcript: "fever",
    words: [{ text: "fever", confidence: 0.92 }],
  });
  check("confidence 0.92 → clear", clear.outcome === "clear", clear.outcome);
  const unclear = gradeWordAttempt({
    expected: "fever",
    transcript: "fever",
    words: [{ text: "fever", confidence: 0.61 }],
  });
  check("confidence 0.61 → unclear", unclear.outcome === "unclear", unclear.outcome);
  const low = gradeWordAttempt({
    expected: "fever",
    transcript: "fever",
    words: [{ text: "fever", confidence: 0.32 }],
  });
  check("confidence 0.32 → not_yet", low.outcome === "not_yet", low.outcome);
  const absent = gradeWordAttempt({
    expected: "fever",
    transcript: "um i don't know",
    words: [{ text: "um", confidence: 0.99 }],
  });
  check("word not spoken at all → not_yet", absent.outcome === "not_yet" && !absent.found);
  const boundary = gradeWordAttempt({
    expected: "blood test",
    transcript: "blood test",
    words: [
      { text: "blood", confidence: 0.95 },
      { text: "test", confidence: 0.55 },
    ],
  });
  check(
    "a phrase is only as clear as its weakest word",
    boundary.outcome === "unclear",
    `min confidence ${boundary.confidence}`,
  );

  section("Prompt-answer analysis (target-language words vs own languages)");
  const enTarget = { targetLanguage: "en" as const, knownLanguages: ["hi" as const] };
  const english = analysePromptAttempt(
    { index: 0, transcript: "i have a fever and a cough since monday", languageDetected: "en" },
    ["fever", "cough", "prescription"],
    enTarget,
  );
  check(
    "goal words found in the answer",
    english.goalWordsUsed.join(",") === "fever,cough",
    english.goalWordsUsed.join(", "),
  );
  // "i have a fever and a cough since monday" = 9 tokens
  check("target-language word count counted", english.targetWordCount === 9, String(english.targetWordCount));
  check("target-language answer not flagged as own language", !english.usedOwnLanguage);

  const hindi = analysePromptAttempt(
    { index: 1, transcript: "मुझे बुखार है", languageDetected: "hi" },
    ["fever"],
    enTarget,
  );
  check("Hindi answer flagged as own language (script + detected)", hindi.ownLanguagesUsed.join(",") === "hi");
  check("own-language tokens excluded from the target count", hindi.targetWordCount === 0);

  const deTarget = { targetLanguage: "de" as const, knownLanguages: ["hi" as const, "en" as const] };
  const german = analysePromptAttempt(
    { index: 0, transcript: "Ich habe Fieber und Übelkeit", languageDetected: "de" },
    ["Fieber", "Übelkeit", "Rezept"],
    deTarget,
  );
  check(
    "German answer: goal words found, counted as target words",
    german.goalWordsUsed.join(",") === "Fieber,Übelkeit" && german.targetWordCount === 5,
    `${german.goalWordsUsed.join(", ")}; ${german.targetWordCount} target words`,
  );
  const englishForGerman = analysePromptAttempt(
    { index: 1, transcript: "I have a fever", languageDetected: "en" },
    ["Fieber"],
    deTarget,
  );
  check(
    "English answer from a de learner: 0 target words, flagged as own language en",
    englishForGerman.targetWordCount === 0 && englishForGerman.ownLanguagesUsed.join(",") === "en",
    `${englishForGerman.targetWordCount} target words; own=${englishForGerman.ownLanguagesUsed.join(",")}`,
  );

  section("German-aware normalisation");
  check("ß ≡ ss (Straße / Strasse)", containsPhrase("wo ist die Strasse", "Straße"));
  check("ü ≡ ue (für / fuer)", containsPhrase("das ist fuer mich", "für"));
  check("ä ≡ ae (Ärztin / Aerztin)", containsPhrase("die aerztin kommt", "Ärztin"));
  check(
    "umlauts are NOT stripped: schon ≠ schön",
    !containsPhrase("das ist schon gut", "schön") && foldForMatching("schön") !== foldForMatching("schon"),
  );
  check(
    "decomposed ü (u + U+0308) matches precomposed ü (NFC)",
    containsPhrase("für", "für"),
  );
  check("capital ẞ folds like ß", foldForMatching("STRAẞE") === foldForMatching("Straße"));
  check("German noun capitalisation ignored", containsPhrase("ich habe fieber", "Fieber"));
  check(
    "compound split by ASR still matches (Fremdenführer ← 'fremden Führer', observed live)",
    containsPhrase("Ich brauche einen fremden Führer.", "Fremdenführer"),
  );
  check(
    "split compound confidence = its weakest part",
    confidenceFor("Fremdenführer", [
      { text: "fremden", confidence: 0.912 },
      { text: "Führer.", confidence: 0.793 },
    ]) === 0.793,
  );
  check(
    "punctuation attached to ASR words is ignored for confidence ('Doctor.')",
    confidenceFor("doctor", [{ text: "Doctor.", confidence: 0.619 }]) === 0.619,
  );
  check(
    "whole-token boundaries kept: 'test' still not inside 'testing'",
    !containsPhrase("the testing centre", "test"),
  );

  section("Bucket combination (used → canUse, clear-but-unused → practising)");
  const buckets = combineWordBuckets({
    goalWords: ["fever", "cough", "prescription", "pharmacy", "appointment"],
    clearInWordTest: new Set(["fever", "cough", "prescription"]),
    usedInPrompts: new Set(["fever", "pharmacy"]),
  });
  check(
    "used in an answer → canUse (even if unclear in the word test)",
    buckets.canUse.join(",") === "fever,pharmacy",
    buckets.canUse.join(", "),
  );
  check(
    "clear in the word test but unused → practising",
    buckets.practising.join(",") === "cough,prescription",
    buckets.practising.join(", "),
  );
  check("everything else → notYet", buckets.notYet.join(",") === "appointment");
  check(
    "buckets partition the vocabulary exactly once",
    buckets.canUse.length + buckets.practising.length + buckets.notYet.length === 5,
  );

  section("Level bands (<15 starting, <40 basic, <70 intermediate, else confident)");
  check("5/100 → starting", computeLevel(5, 100) === "starting");
  check("14/100 → starting", computeLevel(14, 100) === "starting");
  check("15/100 → basic", computeLevel(15, 100) === "basic");
  check("39/100 → basic", computeLevel(39, 100) === "basic");
  check("40/100 → intermediate", computeLevel(40, 100) === "intermediate");
  check("69/100 → intermediate", computeLevel(69, 100) === "intermediate");
  check("70/100 → confident", computeLevel(70, 100) === "confident");
  check("empty vocabulary → starting (no divide by zero)", computeLevel(0, 0) === "starting");

  section("Pricing");
  check("day = $0.99", priceFor("day", 3) === 0.99);
  check("week = $4.99", priceFor("week", undefined) === 4.99);
  check("quick_prep = $0.99", priceFor("quick_prep", undefined) === 0.99);
  check("regen of a single day = $0.49", priceFor("regen", 2) === 0.49);
  check("regen of the whole week = $1.99", priceFor("regen", undefined) === 1.99);

  section("Purchase unlock rules");
  const none = computeDayAccess({ dayNo: 1, purchases: [] });
  check("day 1 preview visible with no purchase", none.previewAvailable && !none.unlocked);
  const noneDay4 = computeDayAccess({ dayNo: 4, purchases: [] });
  check("day 4 fully locked with no purchase", !noneDay4.previewAvailable && !noneDay4.unlocked);
  const week = [{ type: "week" as const, dayNo: undefined }];
  check(
    "week purchase unlocks all 7 days",
    [1, 2, 3, 4, 5, 6, 7].every((d) => computeDayAccess({ dayNo: d, purchases: week }).unlocked),
  );
  const day3 = [{ type: "day" as const, dayNo: 3 }];
  check("day purchase unlocks only that day", computeDayAccess({ dayNo: 3, purchases: day3 }).unlocked);
  check(
    "day purchase does not leak into other days",
    !computeDayAccess({ dayNo: 4, purchases: day3 }).unlocked,
  );
  const quick = [{ type: "quick_prep" as const, dayNo: undefined }];
  check("quick_prep unlocks day 1", computeDayAccess({ dayNo: 1, purchases: quick }).unlocked);
  check(
    "quick_prep does not unlock day 2",
    !computeDayAccess({ dayNo: 2, purchases: quick }).unlocked,
  );
  check(
    "a regen purchase alone unlocks nothing",
    !computeDayAccess({ dayNo: 1, purchases: [{ type: "regen", dayNo: undefined }] }).unlocked,
  );

  section("Today-card day selection");
  const base = 1_700_000_000_000;
  check("same day → day 1", currentDayNo({ now: base, generatedAt: base, dayCount: 7 }) === 1);
  check(
    "3 days later → day 4",
    currentDayNo({ now: base + 3 * 86_400_000, generatedAt: base, dayCount: 7 }) === 4,
  );
  check(
    "beyond the plan clamps to the last day",
    currentDayNo({ now: base + 30 * 86_400_000, generatedAt: base, dayCount: 7 }) === 7,
  );
  check(
    "a clock behind the plan clamps to day 1",
    currentDayNo({ now: base - 86_400_000, generatedAt: base, dayCount: 7 }) === 1,
  );

  section("Words-per-day table");
  check("5 min → 3 words", wordsPerDayFor(5) === 3);
  check("15 min → 5 words", wordsPerDayFor(15) === 5);
  check("30 min → 7 words", wordsPerDayFor(30) === 7);
  check("45 min → 9 words", wordsPerDayFor(45) === 9);

  section("Language profile rule");
  const profileOk = (known: string[], primary: string, target: string): boolean => {
    try {
      normalizeLanguageProfile({ knownLanguages: known, primaryLanguage: primary, targetLanguage: target });
      return true;
    } catch {
      return false;
    }
  };
  check('known ["en"] + target "en" rejected (target is the only known language)', !profileOk(["en"], "en", "en"));
  check('known ["en","hi"] + target "en" allowed', profileOk(["en", "hi"], "hi", "en"));
  check('known ["hi","en"], primary "hi", target "de" allowed', profileOk(["hi", "en"], "hi", "de"));
  check("primary must be one of knownLanguages", !profileOk(["hi"], "te", "en"));
  check("empty knownLanguages rejected", !profileOk([], "hi", "en"));
  check('unsupported known language ("fr") rejected', !profileOk(["fr"], "fr", "en"));
  check('unsupported target language ("hi") rejected', !profileOk(["en"], "en", "hi"));
  const deduped = normalizeLanguageProfile({
    knownLanguages: ["hi", "en", "hi"],
    primaryLanguage: "hi",
    targetLanguage: "de",
  });
  check("knownLanguages de-duplicated, order kept", deduped.knownLanguages.join(",") === "hi,en");

  section("Legacy nativeLanguage backfill mapping (migration result shape)");
  const mapLegacy = (value: unknown) => planLegacyLanguageBackfill(value);
  const hiPlan = mapLegacy("hi");
  check(
    'nativeLanguage "hi" → known [hi], primary hi, target en',
    hiPlan.kind === "migrate" &&
      hiPlan.profile.knownLanguages.join(",") === "hi" &&
      hiPlan.profile.primaryLanguage === "hi" &&
      hiPlan.profile.targetLanguage === "en",
  );
  const enPlan = mapLegacy("en");
  check(
    'nativeLanguage "en" → known [en], primary en, target de (satisfies the rule)',
    enPlan.kind === "migrate" && enPlan.profile.targetLanguage === "de",
  );
  const tePlan = mapLegacy("te");
  check('nativeLanguage "te" → target en', tePlan.kind === "migrate" && tePlan.profile.targetLanguage === "en");
  check('unsupported "bn" → left unset, value reported', mapLegacy("bn").kind === "unsupported");
  check("no legacy value → nothing to do", mapLegacy(undefined).kind === "none");
  check(
    "every migrated profile passes the profile rule",
    ["en", "hi", "te"].every((code) => {
      const plan = mapLegacy(code);
      return plan.kind === "migrate" && profileOk(plan.profile.knownLanguages, plan.profile.primaryLanguage, plan.profile.targetLanguage);
    }),
  );

  section("Pronunciation-hint script validation");
  const hintOk = (hint: string, word: string, primary: "hi" | "te" | "en"): boolean => {
    try {
      validatePronunciationHint(hint, word, primary, "hint");
      return true;
    } catch {
      return false;
    }
  };
  check("hi: Devanagari hint accepted (Guten Tag → गूटेन टाग)", hintOk("गूटेन टाग", "Guten Tag", "hi"));
  check("te: Telugu hint accepted (Guten Tag → గూటెన్ టాగ్)", hintOk("గూటెన్ టాగ్", "Guten Tag", "te"));
  check("en: Latin sound-alike accepted (GOO-ten tahg)", hintOk("GOO-ten tahg", "Guten Tag", "en"));
  check("hi: Latin hint rejected", !hintOk("goo-ten tahg", "Guten Tag", "hi"));
  check("hi: Telugu hint rejected (wrong script)", !hintOk("గూటెన్ టాగ్", "Guten Tag", "hi"));
  check("te: Devanagari hint rejected (wrong script)", !hintOk("गूटेन टाग", "Guten Tag", "te"));
  check("hi: mixed Devanagari + Latin rejected", !hintOk("गूटेन Tag", "Guten Tag", "hi"));
  check("hi: hint that just repeats the word rejected", !hintOk("Guten Tag", "Guten Tag", "hi"));
  check("te: hint that just repeats the word rejected", !hintOk("doctor", "doctor", "te"));
  check("empty hint rejected", !hintOk("   ", "doctor", "hi"));
  check("en: Devanagari hint rejected", !hintOk("डॉक्टर", "doctor", "en"));
  check("script check ignores punctuation/hyphens", isWrittenInScript("गू-टेन, टाग!", "Devanagari"));

  const backfill = validateHintBackfill(
    { hints: [{ word: "Fever", pronunciationHint: "फ़ीवर" }, { word: "extra", pronunciationHint: "एक्स्ट्रा" }] },
    { words: ["fever"], primaryLanguage: "hi" },
  );
  check(
    "hint backfill keyed by the requested word; extra words ignored",
    backfill.size === 1 && backfill.get("fever") === "फ़ीवर",
  );
  rejects("hint backfill with a requested word missing rejected", () =>
    validateHintBackfill({ hints: [] }, { words: ["fever"], primaryLanguage: "hi" }),
  );
  rejects("hint backfill with a Latin hint for hi rejected", () =>
    validateHintBackfill(
      { hints: [{ word: "fever", pronunciationHint: "FEE-ver" }] },
      { words: ["fever"], primaryLanguage: "hi" },
    ),
  );

  section("Streaming model routing (pure)");
  const route = (purpose: "target" | "own", target: "en" | "de", primary: "en" | "hi" | "te") =>
    streamRouteFor(purpose, { targetLanguage: target, primaryLanguage: primary });
  check("target de → u3-rt-pro", route("target", "de", "hi").speechModel === "u3-rt-pro");
  check("target en → u3-rt-pro", route("target", "en", "te").speechModel === "u3-rt-pro");
  check("own hi → whisper-rt", route("own", "de", "hi").speechModel === "whisper-rt");
  check("own te → whisper-rt", route("own", "en", "te").speechModel === "whisper-rt");
  check("own en → the target-language model (u3-rt-pro)", route("own", "de", "en").speechModel === "u3-rt-pro");

  section("Gendered phrasing only for Hindi");
  check("hi + female → feminine agreement", genderGuidance("hi", "female").includes("feminine"));
  check("hi + male → masculine agreement", genderGuidance("hi", "male").includes("masculine"));
  check("hi + unspecified → neutral", genderGuidance("hi", "unspecified").includes("neutral"));
  check("te + female → neutral", genderGuidance("te", "female") === "Use gender-neutral phrasing throughout.");
  check("en + male → neutral", genderGuidance("en", "male") === "Use gender-neutral phrasing throughout.");

  section("LLM-output validators ACCEPT well-formed output");
  const hiLanguages = { targetLanguage: "en" as const, primaryLanguage: "hi" as const };
  const goodTargets = {
    words: Array.from({ length: 40 }, (_, i) => ({
      word: `word${i}`,
      meaning: `अर्थ ${i}`,
      pronunciationHint: `वर्ड ${i}`,
      priority: (i % 3) + 1,
    })),
    patterns: Array.from({ length: 5 }, (_, i) => ({
      pattern: `Can I ___ ${i}?`,
      example: `Can I sit ${i}?`,
      meaning: `मतलब ${i}`,
    })),
    levelCheckWords: ["word0", "word1", "word2", "word3", "word4"],
    levelCheckPrompts: [
      { prompt: "How do you feel today?", translation: "आज आप कैसा महसूस कर रहे हैं?" },
      { prompt: "What hurts?", translation: "कहाँ दर्द है?" },
    ],
  };
  const parsedTargets = validateGoalTargets(goodTargets, hiLanguages);
  check("40 words / 5 patterns / 5 check words / 2 prompts accepted", parsedTargets.words.length === 40);
  check(
    "prompt/translation mapped onto stored english/native",
    parsedTargets.levelCheckPrompts[0]?.english === "How do you feel today?" &&
      parsedTargets.levelCheckPrompts[0]?.native === "आज आप कैसा महसूस कर रहे हैं?",
  );
  check("every word carries its hint", parsedTargets.words.every((w) => w.pronunciationHint.length > 0));

  const goodPlan = {
    days: Array.from({ length: 7 }, (_, d) => ({
      title: `Day ${d + 1}`,
      words: Array.from({ length: 5 }, (_, w) => ({
        word: `word${d * 5 + w}`,
        meaning: "अर्थ",
      })),
      patterns: [`Can I ___ ${d % 5}?`],
      practiceSummary: "Say each word out loud three times, then build one sentence.",
    })),
  };
  const parsedPlan = validatePlanDays(goodPlan, { mode: "week", minutesPerDay: 15 });
  check(
    "7-day / 5-words-per-day plan accepted, dayNo assigned server-side",
    parsedPlan.length === 7 && parsedPlan.map((d) => d.dayNo).join(",") === "1,2,3,4,5,6,7",
  );

  const feedback = validateGrammarFeedback(
    {
      grammar: [
        { name: "Can I ___ ?", status: "ok" },
        { name: "I need ___", status: "practising" },
        { name: "Totally Invented Pattern", status: "ok" },
      ],
      speakingSummary: "आपने अच्छा बोला। अब वाक्य बनाने का अभ्यास करें।",
    },
    ["Can I ___ ?", "I need ___", "Where is ___ ?"],
  );
  check(
    "grammar statuses mapped onto the SERVER's pattern list",
    feedback.grammar.length === 3 && feedback.grammar.map((g) => g.name).join("|") ===
      "Can I ___ ?|I need ___|Where is ___ ?",
  );
  check(
    "a pattern the model omitted defaults to not_yet",
    feedback.grammar[2]?.status === "not_yet",
  );
  check(
    "a pattern the model invented is discarded",
    !feedback.grammar.some((g) => g.name === "Totally Invented Pattern"),
  );

  section("LLM-output validators REJECT malformed output");
  rejects("too few words rejected", () =>
    validateGoalTargets({ ...goodTargets, words: goodTargets.words.slice(0, 5) }, hiLanguages),
  );
  rejects("4 level-check words rejected (must be exactly 5)", () =>
    validateGoalTargets({ ...goodTargets, levelCheckWords: ["a", "b", "c", "d"] }, hiLanguages),
  );
  rejects("duplicate level-check words rejected", () =>
    validateGoalTargets(
      { ...goodTargets, levelCheckWords: ["word0", "word0", "word2", "word3", "word4"] },
      hiLanguages,
    ),
  );
  rejects("empty meaning rejected", () =>
    validateGoalTargets(
      {
        ...goodTargets,
        words: [
          { word: "x", meaning: "   ", pronunciationHint: "एक्स", priority: 1 },
          ...goodTargets.words.slice(1),
        ],
      },
      hiLanguages,
    ),
  );
  rejects("word missing its pronunciationHint rejected", () =>
    validateGoalTargets(
      {
        ...goodTargets,
        words: [{ word: "fever", meaning: "बुखार", priority: 1 }, ...goodTargets.words.slice(1)],
      },
      hiLanguages,
    ),
  );
  rejects("word whose hint is in the wrong script rejected", () =>
    validateGoalTargets(
      {
        ...goodTargets,
        words: [
          { word: "fever", meaning: "बुखार", pronunciationHint: "FEE-ver", priority: 1 },
          ...goodTargets.words.slice(1),
        ],
      },
      hiLanguages,
    ),
  );
  rejects("target word not in Latin script rejected (model answered in the wrong language)", () =>
    validateGoalTargets(
      {
        ...goodTargets,
        words: [
          { word: "बुखार", meaning: "बुखार", pronunciationHint: "बुखार", priority: 1 },
          ...goodTargets.words.slice(1),
        ],
      },
      hiLanguages,
    ),
  );
  rejects("6-day week plan rejected", () =>
    validatePlanDays({ days: goodPlan.days.slice(0, 6) }, { mode: "week", minutesPerDay: 15 }),
  );
  rejects("wrong words-per-day rejected (15 min must be 5)", () =>
    validatePlanDays(goodPlan, { mode: "week", minutesPerDay: 30 }),
  );
  rejects("quick_prep with 7 days rejected", () =>
    validatePlanDays(goodPlan, { mode: "quick_prep", minutesPerDay: 15 }),
  );
  rejects("plan day with an empty practiceSummary rejected", () =>
    validatePlanDays(
      { days: goodPlan.days.map((d, i) => (i === 2 ? { ...d, practiceSummary: "" } : d)) },
      { mode: "week", minutesPerDay: 15 },
    ),
  );
  rejects("non-JSON-object input rejected", () => validateGoalTargets("not an object", hiLanguages));
  rejects("bad grammar status rejected", () =>
    validateGrammarFeedback(
      { grammar: [{ name: "x", status: "excellent" }], speakingSummary: "ok" },
      ["x"],
    ),
  );
  rejects("missing speakingSummary rejected", () =>
    validateGrammarFeedback({ grammar: [] }, ["x"]),
  );
}

// ---------------------------------------------------------------------------
// Part B — live deployment, no LLM required
// ---------------------------------------------------------------------------

function readConvexUrl(): string {
  const envPath = path.join(ROOT, ".env.local");
  if (!existsSync(envPath)) throw new Error(".env.local not found; run `npx convex dev --once`");
  const match = readFileSync(envPath, "utf8").match(/^CONVEX_URL=(.+)$/m);
  if (match === null || match[1] === undefined) throw new Error("CONVEX_URL missing from .env.local");
  return match[1].trim();
}

async function expectThrow(name: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  let message = "";
  try {
    await fn();
  } catch (error) {
    threw = true;
    message = error instanceof Error ? error.message : String(error);
  }
  check(name, threw, threw ? message.split("\n")[0]?.slice(0, 90) ?? "" : "did NOT throw");
}

function runConvexCli(args: string[]): string {
  // Through Node, not `npx`: spawning a `.cmd` shim fails with EINVAL on Windows.
  return execFileSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "convex", "bin", "main.js"), ...args],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Signs in to a fixed account, creating it only when it does not exist yet. */
async function signInFixed(
  client: ConvexHttpClient,
  email: string,
  password: string,
): Promise<string | null> {
  try {
    const signedIn = await client.action(api.auth.signIn, {
      provider: "password",
      params: { email, password, flow: "signIn" },
    });
    if (typeof signedIn.tokens?.token === "string") return signedIn.tokens.token;
  } catch {
    // Account does not exist yet: fall through to sign-up.
  }
  const signedUp = await client.action(api.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signUp" },
  });
  return signedUp.tokens?.token ?? null;
}

async function partB(): Promise<void> {
  console.log("\n\nPART B — live Convex deployment (no LLM required)");
  const url = readConvexUrl();
  console.log(`  Deployment: ${url}`);

  section("Convex Auth");
  const anon = new ConvexHttpClient(url);
  await expectThrow("anonymous users.me is not an error but returns null", async () => {
    const result = await anon.query(api.users.me, {});
    if (result === null) throw new Error("returned null as expected");
    return result;
  });
  await expectThrow("anonymous goals.activeGoal rejected", () =>
    anon.query(api.goals.activeGoal, {}),
  );
  await expectThrow("anonymous goals.setGoal rejected", () =>
    anon.mutation(api.goals.setGoal, {
      goalType: "travel",
      goalText: "hack",
      deadline: "none",
      minutesPerDay: 15,
    }),
  );
  await expectThrow("anonymous levelCheck.startLevelCheck rejected", () =>
    anon.mutation(api.levelCheck.startLevelCheck, {}),
  );
  await expectThrow("anonymous home.progressCounts rejected", () =>
    anon.query(api.home.progressCounts, {}),
  );

  await expectThrow("anonymous levelCheck.getStreamConfig rejected", () =>
    anon.query(api.levelCheck.getStreamConfig, { purpose: "target" }),
  );

  // Fixed, reused accounts (the project's dev rule). Random per-run users used
  // to call setGoal twice per run, silently spending 2 LLM generations each
  // time; reusing Alice's goal keeps verify at 0 LLM calls after its first run.
  const alice = new ConvexHttpClient(url);
  const bob = new ConvexHttpClient(url);
  const carol = new ConvexHttpClient(url); // never gets a profile
  const aliceToken = await signInFixed(alice, "verify-a@speakup.dev", "verify-fixed-password-a");
  const bobToken = await signInFixed(bob, "verify-b@speakup.dev", "verify-fixed-password-b");
  const carolToken = await signInFixed(carol, "verify-c@speakup.dev", "verify-fixed-password-c");
  check(
    "fixed accounts signed in (created on first run)",
    aliceToken !== null && bobToken !== null && carolToken !== null,
  );
  if (aliceToken === null || bobToken === null || carolToken === null) return;
  alice.setAuth(aliceToken);
  bob.setAuth(bobToken);
  carol.setAuth(carolToken);

  section("Profile (server-side rule, caller is always the signed-in user)");
  await alice.mutation(api.users.updateProfile, {
    knownLanguages: ["hi", "en", "hi"],
    primaryLanguage: "hi",
    targetLanguage: "en",
    gender: "female",
  });
  const me = await alice.query(api.users.me, {});
  check(
    "profile saved and read back (known de-duplicated)",
    me?.knownLanguages?.join(",") === "hi,en" &&
      me?.primaryLanguage === "hi" &&
      me?.targetLanguage === "en" &&
      me?.gender === "female",
    `known=${me?.knownLanguages?.join(",")} primary=${me?.primaryLanguage} target=${me?.targetLanguage}`,
  );
  check("createdAt stamped at account creation", typeof me?.createdAt === "number");
  await expectThrow('known ["en"] + target "en" rejected by the server', () =>
    carol.mutation(api.users.updateProfile, {
      knownLanguages: ["en"],
      primaryLanguage: "en",
      targetLanguage: "en",
      gender: "male",
    }),
  );
  await expectThrow("primary not in knownLanguages rejected by the server", () =>
    carol.mutation(api.users.updateProfile, {
      knownLanguages: ["hi"],
      primaryLanguage: "te",
      targetLanguage: "en",
      gender: "male",
    }),
  );
  await expectThrow("unsupported language code rejected by the validator", () =>
    carol.mutation(api.users.updateProfile, {
      knownLanguages: ["xx" as "en"],
      primaryLanguage: "en",
      targetLanguage: "de",
      gender: "male",
    }),
  );

  section("No profile yet");
  const carolMe = await carol.query(api.users.me, {});
  check(
    "me() returns null for unset language fields",
    carolMe !== null &&
      carolMe.knownLanguages === null &&
      carolMe.primaryLanguage === null &&
      carolMe.targetLanguage === null,
  );
  await expectThrow("setGoal rejected until the language profile exists", () =>
    carol.mutation(api.goals.setGoal, {
      goalType: "travel",
      goalText: "Ask for directions",
      deadline: "none",
      minutesPerDay: 5,
    }),
  );
  await expectThrow("getStreamConfig rejected until the language profile exists", () =>
    carol.query(api.levelCheck.getStreamConfig, { purpose: "own" }),
  );

  section("Goal (reused across runs)");
  let active = await alice.query(api.goals.activeGoal, {});
  if (active === null) {
    await alice.mutation(api.goals.setGoal, {
      goalType: "doctor",
      goalText: "Explain my symptoms to a doctor",
      deadline: "2_4_weeks",
      minutesPerDay: 15,
    });
    active = await alice.query(api.goals.activeGoal, {});
    check("goals.setGoal created a goal (first run only)", active !== null);
  } else {
    check("existing active goal reused — no new generation", true, active._id);
  }
  if (active === null) return;
  const goalId = active._id;
  check(
    "activeGoal reports a targetsReady flag",
    typeof active.targetsReady === "boolean",
    `targetsReady=${active.targetsReady}`,
  );
  // Only assertable while generation has not landed yet — asserting the
  // opposite would race the scheduler.
  if (active.targetsReady === false) {
    await expectThrow("startLevelCheck refuses while targets are not ready", () =>
      alice.mutation(api.levelCheck.startLevelCheck, {}),
    );
  } else if (active.targets !== null) {
    check(
      "targets carry their generation-language snapshot",
      active.targets.targetLanguage === "en" && active.targets.primaryLanguage === "hi",
      `target=${active.targets.targetLanguage} primary=${active.targets.primaryLanguage}`,
    );
    const snapshotRoute = await alice.query(api.levelCheck.getStreamConfig, { purpose: "target" });
    check(
      "getStreamConfig uses the goal snapshot once targets exist",
      snapshotRoute.languageSource === "goal" && snapshotRoute.language === active.targets.targetLanguage,
      `${snapshotRoute.speechModel} / ${snapshotRoute.language} from ${snapshotRoute.languageSource}`,
    );
  }

  section("Home before any plan");
  check("home.todayCard is null with no plan", (await alice.query(api.home.todayCard, { now: Date.now() })) === null);
  check("home.progressCounts is null before scoring", (await alice.query(api.home.progressCounts, {})) === null);
  await expectThrow("home.todayCard rejects a non-finite clock", () =>
    alice.query(api.home.todayCard, { now: Number.NaN }),
  );

  section("getStreamConfig routing (live; Bob has no goal, so the profile decides)");
  const routeFor = async (
    profile: { knownLanguages: Array<"en" | "hi" | "te">; primaryLanguage: "en" | "hi" | "te"; targetLanguage: "en" | "de" },
    purpose: "target" | "own",
  ) => {
    await bob.mutation(api.users.updateProfile, { ...profile, gender: "unspecified" });
    return await bob.query(api.levelCheck.getStreamConfig, { purpose });
  };
  const hiDe = { knownLanguages: ["hi", "en"] as Array<"en" | "hi" | "te">, primaryLanguage: "hi" as const, targetLanguage: "de" as const };
  const deTarget = await routeFor(hiDe, "target");
  check(
    "target de → u3-rt-pro, language_detection on",
    deTarget.speechModel === "u3-rt-pro" &&
      deTarget.language === "de" &&
      deTarget.connectionParams.speech_model === "u3-rt-pro" &&
      deTarget.connectionParams.language_detection === "true" &&
      deTarget.languageSource === "profile",
    JSON.stringify(deTarget.connectionParams),
  );
  const hiOwn = await routeFor(hiDe, "own");
  check("own hi → whisper-rt", hiOwn.speechModel === "whisper-rt" && hiOwn.language === "hi");
  const teOwn = await routeFor(
    { knownLanguages: ["te", "en"], primaryLanguage: "te", targetLanguage: "en" },
    "own",
  );
  check("own te → whisper-rt", teOwn.speechModel === "whisper-rt" && teOwn.language === "te");
  const enTarget = await routeFor(
    { knownLanguages: ["te", "en"], primaryLanguage: "te", targetLanguage: "en" },
    "target",
  );
  check("target en → u3-rt-pro", enTarget.speechModel === "u3-rt-pro" && enTarget.language === "en");
  const enOwn = await routeFor(
    { knownLanguages: ["en", "hi"], primaryLanguage: "en", targetLanguage: "de" },
    "own",
  );
  check(
    "own en → the target-language model (u3-rt-pro)",
    enOwn.speechModel === "u3-rt-pro" && enOwn.language === "en",
  );

  section("Migration (live, via the Convex CLI)");
  const migration = JSON.parse(
    runConvexCli([
      "run",
      "migrations:backfillUserLanguages",
      JSON.stringify({ paginationOpts: { numItems: 200, cursor: null } }),
    ]),
  ) as Record<string, unknown>;
  const expectedKeys = [
    "alreadyMigrated",
    "continueCursor",
    "isDone",
    "legacyCleared",
    "migrated",
    "scanned",
    "unset",
    "unsupported",
  ];
  check(
    "backfillUserLanguages returns the documented result shape",
    expectedKeys.every((k) => k in migration) && Array.isArray(migration.unsupported),
    Object.keys(migration).sort().join(", "),
  );
  check(
    "migration already complete: re-run changes nothing (idempotent)",
    migration.migrated === 0 && migration.legacyCleared === 0,
    `migrated=${String(migration.migrated)} legacyCleared=${String(migration.legacyCleared)} alreadyMigrated=${String(migration.alreadyMigrated)} unset=${String(migration.unset)}`,
  );

  section("Per-document ownership isolation");
  await expectThrow("Bob cannot read Alice's plan by goalId", () =>
    bob.query(api.plans.plan, { goalId }),
  );
  await expectThrow("Bob cannot generate a plan for Alice's goal", () =>
    bob.action(api.plans.generatePlan, { goalId }),
  );
  await expectThrow("Bob cannot regen Alice's plan", () =>
    bob.action(api.purchases.regenPlan, { goalId }),
  );
  check(
    "Bob's own activeGoal is unaffected by Alice's goals",
    (await bob.query(api.goals.activeGoal, {})) === null,
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("SpeakUp by AdaptiveSkills — verification (no LLM Gateway access required)");
  console.log("=".repeat(70));
  partA();
  await partB();
}

main()
  .then(() => {
    const failed = checks.filter((c) => !c.ok);
    console.log("\n" + "=".repeat(70));
    console.log(`RESULT: ${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length > 0) {
      console.log("\nFailed checks:");
      for (const c of failed) console.log(`  ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      console.log("\n✗ VERIFICATION FAILED");
      process.exit(1);
    }
    console.log("✓ VERIFICATION PASSED");
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(`\n✗ VERIFICATION ABORTED: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
