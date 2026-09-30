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
import { ConvexError } from "convex/values";
import { computeDayAccess, priceFor } from "../convex/purchases";
import { currentDayNo, wordStatuses } from "../convex/home";
import { DAY_MS, demoPassesEnabled, passWindow } from "../convex/lib/passes";
import { assertPassCovers } from "../convex/lib/authz";
import { SAVED_WORDS_CAP, cleanSavedWordInput, saveDecision } from "../convex/savedWords";
import { validateLookupInput } from "../convex/dictionary";
import {
  validateDictionaryEntry,
  validateGoalTargets,
  validateHintBackfill,
  validatePlanDays,
  validateGrammarFeedback,
  validatePronunciationHint,
  wordsPerDayFor,
} from "../convex/lib/validate";
import {
  buildOptions,
  grammarQuestionsFor,
  labPasses,
  nextPatternStatus,
  nextWordStatus,
  pickDistractors,
  todayKey,
  transcriptContains,
  validateLabGeneration,
} from "../convex/lib/labValidate";
import {
  parseWebhookEvent,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "../convex/lib/razorpay";
import { createHmac } from "node:crypto";
import {
  expandAvailability,
  levelAtLeast,
  partnerApproved,
  partnerEarning,
  partnerEligibleForLearner,
  partnerIsOnline,
  rangesOverlap,
  roomChargeInrPaise,
  roomDisplayUsdCents,
  slotStartsWithinInstance,
  utcOffsetMinutes,
} from "../convex/lib/rooms";
import { roomScriptJsonSchema, scriptLineBounds, validateRoomScript } from "../convex/lib/roomScript";
import {
  foldForMatching,
  isWrittenInScript,
  normalizeLanguageProfile,
  ownLanguagesByScript,
  planLegacyLanguageBackfill,
  streamRouteFor,
} from "../convex/lib/languages";
import {
  AUTO_END_GRACE_MS,
  JOIN_WINDOW_BEFORE_START_MS,
  MIN_TOKEN_TTL_SECONDS,
  extractKeyterms,
  nextLearnerLineIndex,
  scriptLineMatches,
  tokenTtlSeconds,
  withinJoinWindow,
} from "../convex/lib/liveRoom";
import { ruleCheck, ruleCheckAnyLanguage } from "../convex/lib/safety";
import { TokenVerifier } from "livekit-server-sdk";
import type { Id } from "../convex/_generated/dataModel";

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

async function partA(): Promise<void> {
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

  section("Access passes: stacking, coverage, demo gate");
  const T0 = 1_800_000_000_000;
  const fresh = passWindow({ passId: "week", now: T0, latestEndsAt: null });
  check("no prior pass → starts now, 7 days", fresh.startsAt === T0 && fresh.endsAt === T0 + 7 * DAY_MS);
  const month = passWindow({ passId: "month", now: T0, latestEndsAt: null });
  check("month = 30 days", month.endsAt - month.startsAt === 30 * DAY_MS);
  const stacked = passWindow({ passId: "week", now: T0, latestEndsAt: T0 + 3 * DAY_MS });
  check(
    "active pass → renewal starts at its end (stacks)",
    stacked.startsAt === T0 + 3 * DAY_MS && stacked.endsAt === T0 + 10 * DAY_MS,
  );
  const afterExpiry = passWindow({ passId: "week", now: T0, latestEndsAt: T0 - DAY_MS });
  check("expired pass → renewal starts now (no back-dating)", afterExpiry.startsAt === T0);
  const passCode = (candidate: { startsAt: number; endsAt: number } | null): string => {
    try {
      assertPassCovers(candidate, T0);
      return "allowed";
    } catch (error) {
      return error instanceof ConvexError ? String((error.data as { code?: string }).code) : "other";
    }
  };
  check("requireActivePass rule: no pass → no_active_pass", passCode(null) === "no_active_pass");
  check(
    "requireActivePass rule: expired pass → no_active_pass",
    passCode({ startsAt: T0 - 8 * DAY_MS, endsAt: T0 - DAY_MS }) === "no_active_pass",
  );
  check(
    "requireActivePass rule: pass ending exactly now → no_active_pass",
    passCode({ startsAt: T0 - DAY_MS, endsAt: T0 }) === "no_active_pass",
  );
  check(
    "requireActivePass rule: not-yet-started pass → no_active_pass",
    passCode({ startsAt: T0 + DAY_MS, endsAt: T0 + 8 * DAY_MS }) === "no_active_pass",
  );
  check(
    "requireActivePass rule: running pass → allowed",
    passCode({ startsAt: T0 - DAY_MS, endsAt: T0 + DAY_MS }) === "allowed",
  );
  check("startDemoPass refused when ALLOW_DEMO_PASSES is unset", !demoPassesEnabled(undefined));
  check('startDemoPass refused for "false" / "TRUE" / "1"', !["false", "TRUE", "1", ""].some(demoPassesEnabled));
  check('startDemoPass allowed only for exactly "true"', demoPassesEnabled("true"));

  section("Saved words: trimming, limits, dedupe, cap");
  const cleanedWord = cleanSavedWordInput({ word: "  Straße  ", meaning: " सड़क ", pronunciationHint: "  " });
  const plainWord = cleanSavedWordInput({ word: "strasse", meaning: "x" });
  check(
    "trimmed; empty hint dropped; key folded (Straße ≡ strasse)",
    cleanedWord.ok &&
      plainWord.ok &&
      cleanedWord.value.word === "Straße" &&
      cleanedWord.value.meaning === "सड़क" &&
      cleanedWord.value.pronunciationHint === undefined &&
      cleanedWord.value.normalized === "strasse" &&
      plainWord.value.normalized === "strasse",
  );
  check("word of 61 chars rejected", !cleanSavedWordInput({ word: "a".repeat(61), meaning: "m" }).ok);
  check("word of 60 chars accepted", cleanSavedWordInput({ word: "a".repeat(60), meaning: "m" }).ok);
  check("meaning of 201 chars rejected", !cleanSavedWordInput({ word: "w", meaning: "m".repeat(201) }).ok);
  check("hint of 121 chars rejected", !cleanSavedWordInput({ word: "w", meaning: "m", pronunciationHint: "h".repeat(121) }).ok);
  check("empty word rejected", !cleanSavedWordInput({ word: "   ", meaning: "m" }).ok);
  check("punctuation-only word rejected", !cleanSavedWordInput({ word: "!!!", meaning: "m" }).ok);
  const dupAtCap = saveDecision({ duplicateId: "id-1", count: SAVED_WORDS_CAP });
  check("duplicate returns the existing id — even at the cap", dupAtCap.kind === "existing" && dupAtCap.id === "id-1");
  check(`${SAVED_WORDS_CAP} saved → a new word hits "limit"`, saveDecision({ duplicateId: null, count: SAVED_WORDS_CAP }).kind === "limit");
  check(`${SAVED_WORDS_CAP - 1} saved → a new word is inserted`, saveDecision({ duplicateId: null, count: SAVED_WORDS_CAP - 1 }).kind === "insert");

  section("Words tab: status mapping");
  const tabWords = [
    { word: "Fieber", meaning: "बुखार", pronunciationHint: "फ़ीबर" },
    { word: "Übelkeit", meaning: "मतली" },
    { word: "Rezept", meaning: "पर्चा", pronunciationHint: "रेत्सेप्ट" },
    { word: "Apotheke", meaning: "दवा की दुकान" },
  ];
  const mapped = wordStatuses(tabWords, { canUse: ["fieber"], practising: ["Uebelkeit"] });
  check(
    "statuses from the level result (case + umlaut-insensitive), stored order kept",
    mapped.map((w) => `${w.word}:${w.status}`).join(",") === "Fieber:canUse,Übelkeit:practising,Rezept:notYet,Apotheke:notYet",
    mapped.map((w) => `${w.word}:${w.status}`).join(","),
  );
  check("missing hint → null, present hint kept", mapped[1]?.pronunciationHint === null && mapped[0]?.pronunciationHint === "फ़ीबर");
  check("no level result → every word notYet", wordStatuses(tabWords, null).every((w) => w.status === "notYet"));
  check(
    "a word in two buckets takes the strongest (canUse)",
    wordStatuses(tabWords, { canUse: ["Rezept"], practising: ["Rezept"] })[2]?.status === "canUse",
  );

  section("Dictionary: input validation");
  const lookupIn = (w: string) => validateLookupInput(w);
  const okLookup = lookupIn("  Apotheke  ");
  check("trimmed word accepted", okLookup.ok && okLookup.word === "Apotheke" && okLookup.normalized === "apotheke");
  check("phrase with apostrophe/hyphen accepted", lookupIn("don't mind-set").ok);
  check("typographic apostrophe folded", lookupIn("don’t").ok);
  check("umlauts accepted; key folded", (() => { const r = lookupIn("Übelkeit"); return r.ok && r.normalized === "uebelkeit"; })());
  check("41 characters → too_long", (() => { const r = lookupIn("a".repeat(41)); return !r.ok && r.reason === "too_long"; })());
  check("40 characters accepted", lookupIn("a".repeat(40)).ok);
  check("digits → not_a_word", (() => { const r = lookupIn("abc123"); return !r.ok && r.reason === "not_a_word"; })());
  check("punctuation → not_a_word", (() => { const r = lookupIn("hello?"); return !r.ok && r.reason === "not_a_word"; })());
  check("empty → not_a_word", (() => { const r = lookupIn("   "); return !r.ok && r.reason === "not_a_word"; })());
  check("only hyphens → not_a_word", (() => { const r = lookupIn("---"); return !r.ok && r.reason === "not_a_word"; })());

  section("Dictionary: LLM output validation (reuses the hint script rules)");
  const dictOk = (raw: unknown, primary: "hi" | "te" | "en"): boolean => {
    try {
      validateDictionaryEntry(raw, { primaryLanguage: primary });
      return true;
    } catch {
      return false;
    }
  };
  check(
    "valid German entry for hi accepted",
    dictOk({ isWord: true, word: "Apotheke", meaning: "दवा की दुकान", pronunciationHint: "आपोटेके" }, "hi"),
  );
  check(
    "isWord false is a valid answer (other fields ignored)",
    dictOk({ isWord: false, word: "", meaning: "", pronunciationHint: "" }, "hi"),
  );
  check(
    "Latin hint for hi rejected",
    !dictOk({ isWord: true, word: "Apotheke", meaning: "दवा की दुकान", pronunciationHint: "ah-po-TAY-ke" }, "hi"),
  );
  check(
    "Devanagari hint for te rejected",
    !dictOk({ isWord: true, word: "doctor", meaning: "వైద్యుడు", pronunciationHint: "डॉक्टर" }, "te"),
  );
  check(
    "en: Latin sound-alike accepted",
    dictOk({ isWord: true, word: "Apotheke", meaning: "pharmacy", pronunciationHint: "ah-po-TAY-keh" }, "en"),
  );
  check(
    "non-Latin canonical word rejected",
    !dictOk({ isWord: true, word: "दवा", meaning: "दवा", pronunciationHint: "दवा" }, "hi"),
  );
  check(
    "hint longer than 120 chars rejected (must fit a saved word)",
    !dictOk({ isWord: true, word: "Apotheke", meaning: "दवा", pronunciationHint: "आ".repeat(121) }, "hi"),
  );
  check("missing isWord rejected", !dictOk({ word: "x" }, "hi"));

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

  // Words and patterns are referred to by ID, never by copying their text
  // (see plans.ts / lib/validate.ts planJsonSchema) — this is what turns a
  // near-miss like "Ich lerne Deutsch." for pattern "Ich lerne ___." into an
  // impossible answer instead of a silent reconciliation failure.
  const planWordIds = new Set(Array.from({ length: 40 }, (_, i) => `id${i}`));
  const planPatternIds = new Set(Array.from({ length: 5 }, (_, i) => `p${i}`));
  const planOpts = { mode: "week" as const, minutesPerDay: 15, wordIds: planWordIds, patternIds: planPatternIds };
  const goodPlan = {
    days: Array.from({ length: 7 }, (_, d) => ({
      title: `Day ${d + 1}`,
      words: Array.from({ length: 5 }, (_, w) => `id${d * 5 + w}`),
      patterns: [`p${d % 5}`],
      practiceSummary: "Say each word out loud three times, then build one sentence.",
    })),
  };
  const parsedPlan = validatePlanDays(goodPlan, planOpts);
  check(
    "7-day / 5-words-per-day plan accepted, dayNo assigned server-side",
    parsedPlan.length === 7 && parsedPlan.map((d) => d.dayNo).join(",") === "1,2,3,4,5,6,7",
  );
  check(
    "plan words/patterns pass through as IDs for server-side reconciliation",
    parsedPlan[0]?.words[0] === "id0" && parsedPlan[0]?.patterns[0] === "p0",
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
    validatePlanDays({ days: goodPlan.days.slice(0, 6) }, planOpts),
  );
  rejects("wrong words-per-day rejected (15 min must be 5)", () =>
    validatePlanDays(goodPlan, { ...planOpts, minutesPerDay: 30 }),
  );
  rejects("quick_prep with 7 days rejected", () =>
    validatePlanDays(goodPlan, { ...planOpts, mode: "quick_prep" }),
  );
  rejects("plan day with an empty practiceSummary rejected", () =>
    validatePlanDays(
      { days: goodPlan.days.map((d, i) => (i === 2 ? { ...d, practiceSummary: "" } : d)) },
      planOpts,
    ),
  );
  rejects("a word ID outside the allowed set is rejected (the old failure mode this replaces)", () =>
    validatePlanDays(
      { days: goodPlan.days.map((d, i) => (i === 0 ? { ...d, words: ["not-an-id", ...d.words.slice(1)] } : d)) },
      planOpts,
    ),
  );
  rejects("a pattern ID outside the allowed set is rejected", () =>
    validatePlanDays(
      { days: goodPlan.days.map((d, i) => (i === 0 ? { ...d, patterns: ["not-a-pattern-id"] } : d)) },
      planOpts,
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

  section("Lab: day-size rules");
  check(
    "grammar questions scale with minutesPerDay (2/3/4/5)",
    grammarQuestionsFor(5) === 2 &&
      grammarQuestionsFor(15) === 3 &&
      grammarQuestionsFor(30) === 4 &&
      grammarQuestionsFor(45) === 5,
  );
  check("labPasses: 4/5 (80%) passes, 3/5 (60%) does not", labPasses(4, 5) && !labPasses(3, 5));
  check("labPasses: 0 items never passes", !labPasses(0, 0));

  section("Lab: distractors are rule-based, never the answer, never near-duplicates");
  const vocabPool = [
    { text: "Hallo", meaning: "hello" },
    { text: "Halloo", meaning: "a loud shout" }, // edit distance 1 from "Hallo" — excluded
    { text: "Hallon", meaning: "raspberry" }, // same first 4 letters — excluded
    { text: "Guten Tag", meaning: "good day" },
    { text: "Servus", meaning: "hello" }, // same meaning as the answer — excluded
    { text: "Danke", meaning: "thank you" },
    { text: "Bitte", meaning: "please" },
    { text: "Tschüss", meaning: "bye" },
  ];
  const distractors = pickDistractors(vocabPool, { text: "Hallo", meaning: "hello" }, 3, () => 0.999);
  check(
    "3 distractors chosen, none the answer, none near-duplicate or same-meaning",
    distractors.length === 3 &&
      !distractors.some((d) => ["hallo", "halloo", "hallon", "servus"].includes(d.toLowerCase())),
    JSON.stringify(distractors),
  );
  const tinyPool = [{ text: "Hallo", meaning: "hello" }, { text: "Halloo", meaning: "loud" }];
  const fallback = pickDistractors(tinyPool, { text: "Hallo", meaning: "hello" }, 1, () => 0.5);
  check(
    "falls back to 'not the exact same word' when the strict rule can't fill the count",
    fallback.length === 1 && fallback[0] !== "Hallo",
  );
  const { options, correctIndex } = buildOptions("Hallo", ["Danke", "Bitte"], () => 0);
  check(
    "buildOptions shuffles the answer in and reports where it landed",
    options.length === 3 && options[correctIndex] === "Hallo",
  );

  section("Lab: spoken-evidence matching (server-side, deterministic)");
  check(
    "transcript containing the target word/phrase matches",
    transcriptContains("Hallo, wie geht es dir?", "Hallo") &&
      transcriptContains("Ich verstehe nicht wirklich", "Ich verstehe nicht"),
  );
  check(
    "transcript NOT containing the target does not match",
    !transcriptContains("Guten Tag", "Hallo"),
  );

  section("Lab: evidence ladder — tap vs typed/spoken, and the 2-different-days demotion rule");
  const day1 = todayKey(Date.parse("2026-01-01T00:00:00Z"));
  const day2 = todayKey(Date.parse("2026-01-02T00:00:00Z"));
  check("todayKey is a stable UTC YYYY-MM-DD key", day1 === "2026-01-01" && day2 === "2026-01-02");

  check(
    "tap-correct alone moves not_yet -> practising, never straight to can_use",
    nextWordStatus("notYet", true, false, [], day1).status === "practising",
  );
  check(
    "tap-correct alone cannot demote an existing can_use word",
    nextWordStatus("canUse", true, false, [], day1).status === "canUse",
  );
  check(
    "spoken-confirmed correct reaches can_use directly from not_yet",
    nextWordStatus("notYet", true, true, [], day1).status === "canUse",
  );
  check(
    "a wrong answer never demotes on the spot (1st wrong day)",
    nextWordStatus("canUse", false, false, [], day1).status === "canUse",
  );
  const afterFirstWrongDay = nextWordStatus("canUse", false, false, [], day1);
  const afterSecondWrongDay = nextWordStatus(
    "canUse",
    false,
    false,
    afterFirstWrongDay.wrongDays,
    day2,
  );
  check(
    "can_use demotes to practising only after wrong answers on 2 DIFFERENT days",
    afterFirstWrongDay.status === "canUse" &&
      afterFirstWrongDay.wrongDays.length === 1 &&
      afterSecondWrongDay.status === "practising" &&
      afterSecondWrongDay.wrongDays.length === 0,
  );
  check(
    "a wrong answer on the SAME day twice still counts as only 1 day (no early demotion)",
    nextWordStatus("canUse", false, false, [day1], day1).status === "canUse",
  );
  check(
    "the pattern ladder mirrors the word ladder with ok/practising/not_yet",
    nextPatternStatus("not_yet", true, false, [], day1).status === "practising" &&
      nextPatternStatus("not_yet", true, true, [], day1).status === "ok",
  );

  section("Lab: generation output — ID-constrained, one blank per word, no duplicate sentences");
  const wordIds = new Set(["w0", "w1", "w2"]);
  const patternIds = new Set(["p0"]);
  const goodLab = {
    grammar: [
      { patternId: "p0", answerWordId: "w0", sentence: "Ich ___ Deutsch.", meaning: "I speak German." },
      { patternId: "p0", answerWordId: "w1", sentence: "Ich ___ Wasser.", meaning: "I need water." },
    ],
    story: [
      { wordId: "w0", sentence: "Ich ___ Deutsch.", meaning: "I speak German." },
      { wordId: "w1", sentence: "Ich ___ Wasser.", meaning: "I need water." },
      { wordId: "w2", sentence: "Das ist ___.", meaning: "That is good." },
    ],
  };
  const labOpts = { wordIds, patternIds, grammarCount: 2, wordIdsInOrder: ["w0", "w1", "w2"] };
  const parsedLab = validateLabGeneration(goodLab, labOpts);
  check(
    "well-formed lab (ID-based, one blank per word) accepted",
    parsedLab.grammar.length === 2 && parsedLab.story.length === 3,
  );
  rejects("a word ID outside the allowed set is rejected", () =>
    validateLabGeneration(
      { ...goodLab, story: [{ ...goodLab.story[0], wordId: "not-an-id" }, ...goodLab.story.slice(1)] },
      labOpts,
    ),
  );
  rejects("a pattern ID outside the allowed set is rejected", () =>
    validateLabGeneration(
      { ...goodLab, grammar: [{ ...goodLab.grammar[0], patternId: "not-a-pattern-id" }, goodLab.grammar[1]] },
      labOpts,
    ),
  );
  rejects("a sentence with no blank marker is rejected", () =>
    validateLabGeneration(
      { ...goodLab, story: [{ ...goodLab.story[0], sentence: "Ich spreche Deutsch." }, ...goodLab.story.slice(1)] },
      labOpts,
    ),
  );
  rejects("a sentence with two blank markers is rejected", () =>
    validateLabGeneration(
      { ...goodLab, story: [{ ...goodLab.story[0], sentence: "Ich ___ ___." }, ...goodLab.story.slice(1)] },
      labOpts,
    ),
  );
  rejects("story missing a blank for one of today's words is rejected (must be a bijection)", () =>
    validateLabGeneration({ ...goodLab, story: goodLab.story.slice(0, 2) }, labOpts),
  );
  rejects("story with a repeated wordId (and a missing one) is rejected", () =>
    validateLabGeneration(
      { ...goodLab, story: [goodLab.story[0], goodLab.story[0], goodLab.story[2]] },
      labOpts,
    ),
  );
  rejects("two grammar questions reusing the same answerWordId are rejected (even with identical sentence text)", () =>
    validateLabGeneration(
      {
        ...goodLab,
        grammar: [
          goodLab.grammar[0],
          { ...goodLab.grammar[1], answerWordId: goodLab.grammar[0]!.answerWordId, sentence: goodLab.grammar[0]!.sentence },
        ],
      },
      labOpts,
    ),
  );
  check(
    "identical sentence TEXT across grammar questions is fine as long as answerWordId differs (a short pattern like \"Mein ___ tut weh\" leaves no room to vary the visible text)",
    validateLabGeneration(
      { ...goodLab, grammar: [goodLab.grammar[0], { ...goodLab.grammar[1], sentence: goodLab.grammar[0]!.sentence }] },
      labOpts,
    ).grammar.length === 2,
  );
  rejects("wrong grammar question count is rejected", () =>
    validateLabGeneration({ ...goodLab, grammar: [goodLab.grammar[0]] }, labOpts),
  );

  section("Razorpay: signature verification (HMAC-SHA256, computed independently via node:crypto)");
  const orderId = "order_RB58MiP5SPFYyM";
  const paymentId = "pay_DESlfW9H8K9uqM";
  const keySecret = "test_key_secret_abc123";
  const goodCheckoutSig = createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  check(
    "Checkout signature verifies: HMAC-SHA256(order_id|payment_id, key_secret)",
    await verifyCheckoutSignature({ orderId, paymentId, signature: goodCheckoutSig, keySecret }),
  );
  check(
    "Checkout signature rejects a wrong signature",
    !(await verifyCheckoutSignature({ orderId, paymentId, signature: "0".repeat(64), keySecret })),
  );
  check(
    "Checkout signature rejects a signature computed with the wrong secret",
    !(await verifyCheckoutSignature({ orderId, paymentId, signature: goodCheckoutSig, keySecret: "wrong_secret" })),
  );
  check(
    "Checkout signature rejects a mismatched payment_id (order_id reused for a different payment)",
    !(await verifyCheckoutSignature({ orderId, paymentId: "pay_someOtherPayment", signature: goodCheckoutSig, keySecret })),
  );

  const webhookSecret = "test_webhook_secret_xyz789";
  const rawBody = '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_1","order_id":"order_1"}}}}';
  const goodWebhookSig = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  check(
    "Webhook signature verifies: HMAC-SHA256(raw body, webhook_secret)",
    await verifyWebhookSignature({ rawBody, signature: goodWebhookSig, webhookSecret }),
  );
  check(
    "Webhook signature rejects a body that does not match (re-serialized JSON would fail exactly this way)",
    !(await verifyWebhookSignature({ rawBody: rawBody.replace("payment.captured", "payment.failed"), signature: goodWebhookSig, webhookSecret })),
  );
  check(
    "Webhook signature rejects the right hash under the wrong secret",
    !(await verifyWebhookSignature({ rawBody, signature: goodWebhookSig, webhookSecret: "wrong_secret" })),
  );

  section("Razorpay: webhook payload parsing (never throws on malformed input)");
  const parsedAuthorized = parseWebhookEvent({
    event: "payment.authorized",
    payload: { payment: { entity: { id: "pay_A", order_id: "order_A", status: "authorized" } } },
  });
  check(
    "payment.authorized parsed: orderId + paymentId extracted",
    parsedAuthorized.event === "payment.authorized" && parsedAuthorized.orderId === "order_A" && parsedAuthorized.paymentId === "pay_A",
  );
  const parsedCaptured = parseWebhookEvent({
    event: "payment.captured",
    payload: { payment: { entity: { id: "pay_B", order_id: "order_B" } } },
  });
  check(
    "payment.captured parsed: orderId + paymentId extracted",
    parsedCaptured.event === "payment.captured" && parsedCaptured.orderId === "order_B" && parsedCaptured.paymentId === "pay_B",
  );
  const parsedFailed = parseWebhookEvent({
    event: "payment.failed",
    payload: { payment: { entity: { id: "pay_C", order_id: "order_C", error_description: "Card declined" } } },
  });
  check(
    "payment.failed parsed: orderId + paymentId + errorDescription extracted",
    parsedFailed.event === "payment.failed" &&
      parsedFailed.orderId === "order_C" &&
      parsedFailed.paymentId === "pay_C" &&
      parsedFailed.errorDescription === "Card declined",
  );
  const parsedRefund = parseWebhookEvent({
    event: "refund.processed",
    payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_D", status: "processed" } } },
  });
  check(
    "refund.processed parsed: paymentId extracted",
    parsedRefund.event === "refund.processed" && parsedRefund.paymentId === "pay_D",
  );
  check(
    "an unrecognized event (e.g. order.paid) is unhandled, not a crash",
    parseWebhookEvent({ event: "order.paid", payload: {} }).event === "unhandled",
  );
  check(
    "a payment event missing order_id is unhandled, not a crash",
    parseWebhookEvent({ event: "payment.captured", payload: { payment: { entity: { id: "pay_E" } } } }).event === "unhandled",
  );
  check("a non-object body is unhandled, not a crash", parseWebhookEvent("not an object").event === "unhandled");
  check("null is unhandled, not a crash", parseWebhookEvent(null).event === "unhandled");
  check("a body with no \"event\" field is unhandled, not a crash", parseWebhookEvent({ payload: {} }).event === "unhandled");

  section("Rooms: level eligibility (starting < basic < intermediate < confident)");
  check("levelAtLeast: same level passes", levelAtLeast("basic", "basic"));
  check("levelAtLeast: higher level passes", levelAtLeast("confident", "intermediate"));
  check("levelAtLeast: lower level fails", !levelAtLeast("basic", "intermediate"));
  check("partnerApproved: intermediate and confident approve", partnerApproved("intermediate") && partnerApproved("confident"));
  check("partnerApproved: starting and basic do not", !partnerApproved("starting") && !partnerApproved("basic"));
  check(
    "partnerEligibleForLearner: partner must be at least the learner's level",
    partnerEligibleForLearner("confident", "basic") &&
      partnerEligibleForLearner("intermediate", "intermediate") &&
      !partnerEligibleForLearner("basic", "intermediate"),
  );

  section("Rooms: fixed price table (server-side price, exact task figures)");
  check(
    "chargeInrPaise matches the task's six figures exactly (later/now x 5/10/15 min)",
    roomChargeInrPaise("later", 5) === 129_00 &&
      roomChargeInrPaise("now", 5) === 169_00 &&
      roomChargeInrPaise("later", 10) === 249_00 &&
      roomChargeInrPaise("now", 10) === 329_00 &&
      roomChargeInrPaise("later", 15) === 369_00 &&
      roomChargeInrPaise("now", 15) === 489_00,
  );
  check(
    "displayUsdCents is scaled from $2.99 (later) / $3.99 (now) per 10 min, for the UI only",
    roomDisplayUsdCents("later", 10) === 299 && roomDisplayUsdCents("now", 10) === 399,
  );
  check(
    "partner earning is flat per duration (not now/later-split), ~66.9% of the \"later\" charge",
    partnerEarning(5).earningInrPaise === 86_00 &&
      partnerEarning(10).earningInrPaise === 167_00 &&
      partnerEarning(15).earningInrPaise === 247_00,
  );

  section("Rooms: heartbeat / overlap / availability expansion");
  const t0 = Date.parse("2026-06-15T00:00:00Z"); // a Monday, early enough UTC that the 9am IST slot below hasn't elapsed yet; no DST edge nearby
  check("partnerIsOnline: fresh heartbeat is online", partnerIsOnline(t0 - 60_000, t0));
  check("partnerIsOnline: 2-minute-old heartbeat is still online (inclusive)", partnerIsOnline(t0 - 120_000, t0));
  check("partnerIsOnline: stale heartbeat (>2 min) is offline", !partnerIsOnline(t0 - 121_000, t0));
  check("partnerIsOnline: no heartbeat at all is offline", !partnerIsOnline(undefined, t0));

  check(
    "rangesOverlap: overlapping half-open intervals detected",
    rangesOverlap(0, 100, 50, 150) && rangesOverlap(50, 150, 0, 100) && !rangesOverlap(0, 100, 100, 200),
  );

  const mondayIst: { dayOfWeek: number; startMinute: number; endMinute: number; timezone: string } = {
    dayOfWeek: 1,
    startMinute: 9 * 60,
    endMinute: 10 * 60,
    timezone: "Asia/Kolkata",
  };
  const offset = utcOffsetMinutes("Asia/Kolkata", t0);
  check("utcOffsetMinutes: IST is UTC+330", offset === 330);
  const instances = expandAvailability(mondayIst, t0, 7);
  check("expandAvailability: exactly one Monday instance in a 7-day window", instances.length === 1);
  if (instances[0]) {
    const durationMin = (instances[0].endAt - instances[0].startAt) / 60_000;
    check("expandAvailability: instance duration matches startMinute..endMinute", durationMin === 60);
    const starts = slotStartsWithinInstance(instances[0], 10);
    check("slotStartsWithinInstance: a 60-min window slices into six 10-min starts", starts.length === 6);
    check(
      "slotStartsWithinInstance: starts are exactly 10 minutes apart, none overlapping the window's end",
      starts.every((s, i) => (i === 0 ? s === instances[0]!.startAt : s === starts[i - 1]! + 10 * 60_000)) &&
        starts[starts.length - 1]! + 10 * 60_000 === instances[0].endAt,
    );
  }
  // A 1-day window starting on a Tuesday contains no Monday at all.
  const tuesday = t0 + 86_400_000;
  const noMonday = expandAvailability(mondayIst, tuesday, 1);
  check("expandAvailability: a window containing no matching weekday returns nothing", noMonday.length === 0);

  section("Rooms: script generation validation (ID-constrained, like plans.ts)");
  const scriptWordIds = new Set(["w0", "w1", "w2"]);
  const goodScript = {
    lines: [
      { role: "learner", text: "Hallo, ich möchte einen Termin.", meaning: "Hello, I would like an appointment.", wordIds: ["w0"] },
      { role: "partner", text: "Klar, wann passt es Ihnen?", meaning: "Sure, what time works for you?", wordIds: [] },
      { role: "learner", text: "Morgen um zehn Uhr, bitte.", meaning: "Tomorrow at ten o'clock, please.", wordIds: ["w1", "w2"] },
      { role: "partner", text: "Gut, das ist notiert.", meaning: "Good, that is noted.", wordIds: [] },
    ],
  };
  const scriptOpts = { wordIds: scriptWordIds, minutes: 5 as const }; // 4 lines fits the 5-minute bound (4..6)
  const parsedScript = validateRoomScript(goodScript, scriptOpts);
  check("well-formed script (>=1 learner line, >=1 partner line) accepted", parsedScript.lines.length === 4);
  check("each line's meaning (translation) is carried through", parsedScript.lines[0]!.meaning === "Hello, I would like an appointment.");
  rejects("a line missing \"meaning\" is rejected", () =>
    validateRoomScript({ lines: [...goodScript.lines.slice(0, 3), { role: "partner", text: "x", wordIds: [] }] }, scriptOpts),
  );
  check("scriptLineBounds scales with minutes (5:4-6, 10:6-10, 15:8-14)", scriptLineBounds(5).max === 6 && scriptLineBounds(10).max === 10 && scriptLineBounds(15).max === 14);
  rejects("a word ID outside the allowed set is rejected", () =>
    validateRoomScript({ lines: [...goodScript.lines.slice(0, 3), { role: "partner", text: "x", wordIds: ["not-an-id"] }] }, scriptOpts),
  );
  rejects("a script missing any \"learner\" line is rejected", () =>
    validateRoomScript({ lines: goodScript.lines.map((l) => ({ ...l, role: "partner" })) }, scriptOpts),
  );
  rejects("a script missing any \"partner\" line is rejected", () =>
    validateRoomScript({ lines: goodScript.lines.map((l) => ({ ...l, role: "learner" })) }, scriptOpts),
  );
  rejects("too few lines for the session length is rejected", () =>
    validateRoomScript({ lines: goodScript.lines.slice(0, 1) }, scriptOpts),
  );
  check(
    "roomScriptJsonSchema constrains wordIds to an enum of the allowed IDs",
    JSON.stringify((roomScriptJsonSchema(["w0", "w1"]) as any).properties.lines.items.properties.wordIds.items.enum) === JSON.stringify(["w0", "w1"]),
  );

  // -------------------------------------------------------------------------
  section("Live room: join window / token TTL");
  // -------------------------------------------------------------------------
  {
    const start = Date.parse("2026-06-15T12:10:00Z");
    const end = start + 10 * 60_000; // 10-minute session
    check("withinJoinWindow: false more than 5 min before start", !withinJoinWindow(start - JOIN_WINDOW_BEFORE_START_MS - 1, start, end));
    check("withinJoinWindow: true exactly 5 min before start", withinJoinWindow(start - JOIN_WINDOW_BEFORE_START_MS, start, end));
    check("withinJoinWindow: true mid-session", withinJoinWindow(start + 5 * 60_000, start, end));
    check("withinJoinWindow: true exactly at the end", withinJoinWindow(end, start, end));
    check("withinJoinWindow: false after the end", !withinJoinWindow(end + 1, start, end));
    check(
      "tokenTtlSeconds: matches the remaining time to end+grace",
      tokenTtlSeconds(start, end) === Math.ceil((end + AUTO_END_GRACE_MS - start) / 1000),
    );
    check(
      "tokenTtlSeconds: floors at MIN_TOKEN_TTL_SECONDS near the very end",
      tokenTtlSeconds(end + AUTO_END_GRACE_MS - 5_000, end) === MIN_TOKEN_TTL_SECONDS,
    );
  }

  // -------------------------------------------------------------------------
  section("Live room: script-line matching (deterministic word overlap, no LLM)");
  // -------------------------------------------------------------------------
  {
    check("scriptLineMatches: exact line match", scriptLineMatches("I would like a coffee please", "I would like a coffee please"));
    check(
      "scriptLineMatches: enough overlap counts (a natural partial echo)",
      scriptLineMatches("I would like a coffee", "I would like a coffee please"),
    );
    check("scriptLineMatches: an unrelated sentence does not match", !scriptLineMatches("What time is the train", "I would like a coffee please"));

    const lines = [
      { role: "partner" as const, text: "Good morning, how can I help you?", words: [] },
      { role: "learner" as const, text: "I would like a coffee please", words: ["coffee"] },
      { role: "partner" as const, text: "Sure, anything else?", words: [] },
      { role: "learner" as const, text: "No thank you that is all", words: [] },
    ];
    check("nextLearnerLineIndex: finds the first learner line", nextLearnerLineIndex(lines, new Set()) === 1);
    check("nextLearnerLineIndex: skips a done line", nextLearnerLineIndex(lines, new Set([1])) === 3);
    check("nextLearnerLineIndex: null once every learner line is done", nextLearnerLineIndex(lines, new Set([1, 3])) === null);

    check("extractKeyterms: includes the script's own target words", extractKeyterms(lines).includes("coffee"));
    const namedLines = [{ role: "partner" as const, text: "Hello my name is Maria Schmidt", words: [] }];
    const keyterms = extractKeyterms(namedLines);
    check("extractKeyterms: picks up a non-sentence-initial capitalized name", keyterms.includes("Maria") && keyterms.includes("Schmidt"));
    check("extractKeyterms: skips the sentence-initial capitalized word", !keyterms.includes("Hello"));
  }

  // -------------------------------------------------------------------------
  section("Live room: safety rule check (two-tier, per language, no LLM for a clear outcome)");
  // -------------------------------------------------------------------------
  check("ruleCheck: a clean English sentence is safe", ruleCheck("I would like a coffee please", "en") === "safe");
  check("ruleCheck: a soft English hit is borderline", ruleCheck("shut up you idiot", "en") === "borderline");
  check("ruleCheck: a hard English hit is a violation", ruleCheck("you filthy nigger", "en") === "violation");
  check("ruleCheck: a hard German hit is a violation", ruleCheck("bring dich um", "de") === "violation");
  check("ruleCheck: a soft Hindi hit is borderline", ruleCheck("chup baitho bewakoof", "hi") === "borderline");
  check("ruleCheck: a clean Telugu sentence is safe", ruleCheck("meeru ela unnaru", "te") === "safe");
  check(
    "ruleCheckAnyLanguage: catches an English hard hit even when spoken by someone practicing German",
    ruleCheckAnyLanguage("you filthy nigger") === "violation",
  );
  check(
    "ruleCheckAnyLanguage: catches a Hindi soft hit regardless of room language — code-switching is not a loophole",
    ruleCheckAnyLanguage("chup baitho bewakoof") === "borderline",
  );
  check("ruleCheckAnyLanguage: a clean sentence in any language is safe", ruleCheckAnyLanguage("I would like a coffee please") === "safe");
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

/** Asserts `fn` throws a ConvexError whose data.code is `code`. */
async function expectCode(name: string, code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(name, false, "did NOT throw");
  } catch (error) {
    const got =
      error instanceof ConvexError ? String((error.data as { code?: string }).code) : `non-ConvexError: ${String(error).slice(0, 60)}`;
    check(name, got === code, `code=${got}`);
  }
}

/** For a Promise.allSettled rejection — used by the atomic-booking / first-accept-wins concurrency tests. */
function settledErrorCode(reason: unknown): string {
  return reason instanceof ConvexError ? String((reason.data as { code?: string }).code) : `non-ConvexError: ${String(reason).slice(0, 80)}`;
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

  // -------------------------------------------------------------------------
  section("Paywall: no pass → every gated function refuses (live)");
  check("activePass is null for an account that never had one", (await carol.query(api.passes.activePass, {})) === null);
  await expectCode("home.words refused", "no_active_pass", () => carol.query(api.home.words, {}));
  await expectCode("home.units refused", "no_active_pass", () => carol.query(api.home.units, {}));
  await expectCode("savedWords.list refused", "no_active_pass", () => carol.query(api.savedWords.list, {}));
  await expectCode("savedWords.save refused", "no_active_pass", () =>
    carol.mutation(api.savedWords.save, { word: "fever", meaning: "x", source: "lookup" }),
  );
  await expectCode("dictionary.lookup refused (gate runs before input checks)", "no_active_pass", () =>
    carol.action(api.dictionary.lookup, { word: "!!!" }),
  );

  section("Demo pass + Words / Units tabs (live, Alice)");
  let alicePass = await alice.query(api.passes.activePass, {});
  if (alicePass === null || !alicePass.isActive) {
    const started = await alice.mutation(api.passes.startDemoPass, { passId: "week" });
    check(
      "startDemoPass('week') → 7-day window",
      started.passId === "week" && started.endsAt - started.startsAt === 7 * DAY_MS,
      `${new Date(started.startsAt).toISOString()} → ${new Date(started.endsAt).toISOString()}`,
    );
    alicePass = await alice.query(api.passes.activePass, {});
  } else {
    check("existing active pass reused (no stacking on every run)", true, `ends ${new Date(alicePass.endsAt).toISOString()}`);
  }
  check(
    "activePass → isActive with source demo",
    alicePass !== null && alicePass.isActive && alicePass.source === "demo",
  );

  const aliceWords = await alice.query(api.home.words, {});
  check(
    "home.words: goal words, no level result yet → level null, all notYet",
    aliceWords !== null &&
      aliceWords.level === null &&
      aliceWords.words.length > 0 &&
      aliceWords.words.every((w) => w.status === "notYet") &&
      aliceWords.counts.total === aliceWords.words.length &&
      aliceWords.counts.notYet === aliceWords.counts.total &&
      aliceWords.targetLanguage === "en" &&
      aliceWords.primaryLanguage === "hi",
    aliceWords ? `${aliceWords.counts.total} words, e.g. ${aliceWords.words[0]?.word} → ${aliceWords.words[0]?.pronunciationHint}` : "null",
  );
  const aliceUnits = await alice.query(api.home.units, {});
  check(
    "home.units: goal + concepts, plan null before a level check",
    aliceUnits !== null &&
      aliceUnits.goal.goalType === "doctor" &&
      aliceUnits.concepts.length >= 4 &&
      aliceUnits.plan === null,
    aliceUnits ? `${aliceUnits.concepts.length} concepts, e.g. "${aliceUnits.concepts[0]?.pattern}"` : "null",
  );

  section("Saved words (live, Alice)");
  const firstWord = aliceWords?.words[0];
  if (firstWord !== undefined) {
    const idA = await alice.mutation(api.savedWords.save, {
      word: firstWord.word,
      meaning: firstWord.meaning,
      ...(firstWord.pronunciationHint !== null ? { pronunciationHint: firstWord.pronunciationHint } : {}),
      source: "goal",
    });
    const idB = await alice.mutation(api.savedWords.save, {
      word: `  ${firstWord.word.toUpperCase()}  `,
      meaning: firstWord.meaning,
      source: "goal",
    });
    check("saving the same word twice (case/space-insensitive) returns the same id", idA === idB);
    const listed = await alice.query(api.savedWords.list, {});
    check(
      "list returns it with its hint",
      listed.some((w) => w._id === idA && w.word === firstWord.word && w.source === "goal"),
      `${listed.length} saved`,
    );
    await expectThrow("another user cannot remove it", () => bob.mutation(api.savedWords.remove, { id: idA }));
    check("remove → null", (await alice.mutation(api.savedWords.remove, { id: idA })) === null);
    check("gone from the list", !(await alice.query(api.savedWords.list, {})).some((w) => w._id === idA));
    check("remove again is idempotent (null)", (await alice.mutation(api.savedWords.remove, { id: idA })) === null);
    await expectThrow("over-long meaning rejected by the server", () =>
      alice.mutation(api.savedWords.save, { word: "x", meaning: "m".repeat(201), source: "lookup" }),
    );
  }

  section("grantPass webhook seam: idempotent on externalId (live, Bob, via CLI)");
  const bobMe = await bob.query(api.users.me, {});
  if (bobMe !== null) {
    const grant = () =>
      JSON.parse(
        runConvexCli([
          "run",
          "passes:grantPass",
          JSON.stringify({ userId: bobMe._id, passId: "month", source: "razorpay", externalId: "verify-bob-evt-0001" }),
        ]),
      ) as { id: string; created: boolean; endsAt: number };
    const first = grant();
    const second = grant();
    check(
      "same externalId twice → one pass, second call created:false",
      second.created === false && second.id === first.id,
      `first.created=${first.created} (true only on the very first verify run)`,
    );
    const bobPass = await bob.query(api.passes.activePass, {});
    check("granted pass is active for Bob", bobPass !== null && bobPass.isActive && bobPass.source === "razorpay");
  }

  section("dictionary.lookup (live, test-de: target de, primary hi)");
  const de = new ConvexHttpClient(url);
  const deToken = await signInFixed(de, "test-de@speakup.dev", "speakup-dev-fixed-password-de");
  if (deToken !== null) {
    de.setAuth(deToken);
    const dePass = await de.query(api.passes.activePass, {});
    if (dePass === null || !dePass.isActive) await de.mutation(api.passes.startDemoPass, { passId: "week" });
    const tooLong = await de.action(api.dictionary.lookup, { word: "x".repeat(41) });
    check("41-char input → too_long (no LLM call)", !tooLong.ok && tooLong.reason === "too_long");

    const llm = async () => (await de.query(api.llmMetrics.total, {})).count;
    const c0 = await llm();
    const firstLookup = await de.action(api.dictionary.lookup, { word: "Apotheke" });
    const c1 = await llm();
    const secondLookup = await de.action(api.dictionary.lookup, { word: "  apotheke " });
    const c2 = await llm();
    check(
      "first lookup succeeds (German word, Hindi meaning, Devanagari hint)",
      firstLookup.ok &&
        firstLookup.word === "Apotheke" &&
        /\p{Script=Devanagari}/u.test(firstLookup.meaning) &&
        firstLookup.pronunciationHint !== null &&
        /\p{Script=Devanagari}/u.test(firstLookup.pronunciationHint),
      firstLookup.ok
        ? `${firstLookup.word} — ${firstLookup.meaning} — ${firstLookup.pronunciationHint} (cached=${firstLookup.cached}, ${c1 - c0} LLM call(s))`
        : firstLookup.reason,
    );
    check(
      "second lookup of the same word is a cache hit with 0 LLM calls",
      secondLookup.ok && secondLookup.cached && c2 - c1 === 0,
      `cached=${secondLookup.ok ? secondLookup.cached : "-"}, ${c2 - c1} LLM call(s)`,
    );
  }

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

  // -------------------------------------------------------------------------
  section("Rooms: setup (fixed, reused accounts)");
  // -------------------------------------------------------------------------
  const ROOMS_PASSWORD = "speakup-dev-fixed-password-rooms";
  type RoomsAcct = { client: ConvexHttpClient; userId: string };
  async function roomsAccount(email: string): Promise<RoomsAcct> {
    const client = new ConvexHttpClient(url);
    const token = await signInFixed(client, email, ROOMS_PASSWORD);
    if (token === null) throw new Error(`sign-in failed for ${email}`);
    client.setAuth(token);
    await client.mutation(api.users.updateProfile, {
      knownLanguages: ["en", "hi"],
      primaryLanguage: "hi",
      targetLanguage: "de",
      gender: "unspecified",
    });
    const me = await client.query(api.users.me, {});
    if (me === null) throw new Error(`users.me returned null for ${email}`);
    return { client, userId: me._id as string };
  }

  const learnerA = await roomsAccount("rooms-learner-a@speakup.dev");
  const learnerB = await roomsAccount("rooms-learner-b@speakup.dev");
  const partnerA = await roomsAccount("rooms-partner-a@speakup.dev");
  const partnerB = await roomsAccount("rooms-partner-b@speakup.dev");

  runConvexCli(["run", "dev:seedRoomLearner", JSON.stringify({ userId: learnerA.userId, level: "basic" })]);
  runConvexCli(["run", "dev:seedRoomLearner", JSON.stringify({ userId: learnerB.userId, level: "basic" })]);
  runConvexCli([
    "run",
    "dev:seedPartnerProfile",
    JSON.stringify({ userId: partnerA.userId, targetLanguage: "de", level: "confident", availableNow: false }),
  ]);
  runConvexCli([
    "run",
    "dev:seedPartnerProfile",
    JSON.stringify({ userId: partnerB.userId, targetLanguage: "de", level: "confident", availableNow: false }),
  ]);

  const partnerAProfile = (await partnerA.client.query(api.partners.myPartnerProfiles, {})).find((p) => p.targetLanguage === "de")!;
  const partnerBProfile = (await partnerB.client.query(api.partners.myPartnerProfiles, {})).find((p) => p.targetLanguage === "de")!;
  check(
    "partnerA seeded approved/confident for \"de\"",
    partnerAProfile.status === "approved" && partnerAProfile.level === "confident",
  );
  check(
    "partnerB seeded approved/confident for \"de\"",
    partnerBProfile.status === "approved" && partnerBProfile.level === "confident",
  );

  // Clean slate, so re-running this script never trips over a previous run's bookings/slots.
  runConvexCli(["run", "dev:clearLearnerRoomBookings", JSON.stringify({ userId: learnerA.userId })]);
  runConvexCli(["run", "dev:clearLearnerRoomBookings", JSON.stringify({ userId: learnerB.userId })]);
  runConvexCli(["run", "dev:clearRoomTestData", JSON.stringify({ partnerProfileId: partnerAProfile._id })]);
  runConvexCli(["run", "dev:clearRoomTestData", JSON.stringify({ partnerProfileId: partnerBProfile._id })]);

  // -------------------------------------------------------------------------
  section("Rooms: atomic slot booking — two learners race for one slot, exactly one wins");
  // -------------------------------------------------------------------------
  const targetDay = (new Date().getUTCDay() + 2) % 7; // 2 days out, always inside a 7-day window regardless of today's elapsed time
  await partnerA.client.mutation(api.partners.setWeeklyAvailability, {
    targetLanguage: "de",
    slots: [{ dayOfWeek: targetDay, startMinute: 9 * 60, endMinute: 10 * 60, timezone: "Asia/Kolkata" }],
  });
  const slotsForA = await learnerA.client.query(api.rooms.availableSlots, { targetLanguage: "de", minutes: 10, level: "basic" });
  const targetSlot = slotsForA.find((s) => s.partnerProfileId === partnerAProfile._id);
  check("availableSlots: a concrete bookable slot exists for partnerA", targetSlot !== undefined);

  if (targetSlot) {
    const [slotResA, slotResB] = await Promise.allSettled([
      learnerA.client.mutation(api.rooms.requestRoomLater, {
        scenario: "atomic slot test",
        minutes: 10,
        targetLanguage: "de",
        partnerProfileId: partnerAProfile._id,
        startAt: targetSlot.startAt,
      }),
      learnerB.client.mutation(api.rooms.requestRoomLater, {
        scenario: "atomic slot test",
        minutes: 10,
        targetLanguage: "de",
        partnerProfileId: partnerAProfile._id,
        startAt: targetSlot.startAt,
      }),
    ]);
    const slotWins = [slotResA, slotResB].filter((r) => r.status === "fulfilled").length;
    check("exactly one learner's requestRoomLater succeeds for the same slot", slotWins === 1, `wins=${slotWins}`);
    const slotLoser = [slotResA, slotResB].find((r) => r.status === "rejected");
    check(
      "the losing learner gets a clear \"slot_taken\" error, not silent corruption",
      slotLoser !== undefined && slotLoser.status === "rejected" && settledErrorCode(slotLoser.reason) === "slot_taken",
      slotLoser && slotLoser.status === "rejected" ? `code=${settledErrorCode(slotLoser.reason)}` : "no rejection found",
    );
    const slotWinner = slotResA.status === "fulfilled" ? slotResA.value : slotResB.status === "fulfilled" ? slotResB.value : null;
    if (slotWinner) {
      const detail = await learnerA.client
        .query(api.rooms.roomBookingDetail, { bookingId: slotWinner.bookingId })
        .catch(() => learnerB.client.query(api.rooms.roomBookingDetail, { bookingId: slotWinner.bookingId }));
      check(
        "the winning booking is \"matched\" to partnerA, and only partnerA",
        detail.status === "matched" && detail.partnerId === partnerA.userId,
      );
    }
  }

  // Regression: an all-day rule covering "today" previously leaked slot starts from local
  // midnight (already in the past whenever queried after 00:00), which requestRoomLater then
  // rejected as "not a valid, non-past time" — found live via scripts/e2e.ts's rooms DEV RULE run.
  await partnerB.client.mutation(api.partners.setWeeklyAvailability, {
    targetLanguage: "de",
    slots: [{ dayOfWeek: new Date().getUTCDay(), startMinute: 0, endMinute: 1440, timezone: "Asia/Kolkata" }],
  });
  const nowForPastCheck = Date.now();
  const slotsAllDay = await learnerA.client.query(api.rooms.availableSlots, { targetLanguage: "de", minutes: 10, level: "basic" });
  const partnerBSlots = slotsAllDay.filter((s) => s.partnerProfileId === partnerBProfile._id);
  check(
    "availableSlots never returns a slot start time already in the past (all-day rule for today)",
    partnerBSlots.length > 0 && partnerBSlots.every((s) => s.startAt >= nowForPastCheck),
    `${partnerBSlots.length} slots, earliest=${partnerBSlots[0] ? new Date(partnerBSlots[0].startAt).toISOString() : "none"}`,
  );

  // -------------------------------------------------------------------------
  section("Rooms: first-accept-wins — two partners race to accept, exactly one wins");
  // -------------------------------------------------------------------------
  await partnerA.client.mutation(api.partners.setAvailableNow, { targetLanguage: "de", available: true });
  await partnerB.client.mutation(api.partners.setAvailableNow, { targetLanguage: "de", available: true });

  const nowReq = await learnerA.client.mutation(api.rooms.requestRoomNow, {
    scenario: "first accept wins test",
    minutes: 5,
    targetLanguage: "de",
  });
  const visibleToA = await partnerA.client.query(api.rooms.openNowRequests, {});
  const visibleToB = await partnerB.client.query(api.rooms.openNowRequests, {});
  check(
    "both online, eligible, same-language partners see the request",
    visibleToA.some((r) => r._id === nowReq.bookingId) && visibleToB.some((r) => r._id === nowReq.bookingId),
  );

  const [acceptA, acceptB] = await Promise.allSettled([
    partnerA.client.mutation(api.rooms.acceptRoomRequest, { bookingId: nowReq.bookingId }),
    partnerB.client.mutation(api.rooms.acceptRoomRequest, { bookingId: nowReq.bookingId }),
  ]);
  const acceptWins = [acceptA, acceptB].filter((r) => r.status === "fulfilled").length;
  check("exactly one partner's accept succeeds", acceptWins === 1, `wins=${acceptWins}`);
  const acceptLoser = [acceptA, acceptB].find((r) => r.status === "rejected");
  check(
    "the losing partner gets a clear \"already_matched\" error",
    acceptLoser !== undefined && acceptLoser.status === "rejected" && settledErrorCode(acceptLoser.reason) === "already_matched",
    acceptLoser && acceptLoser.status === "rejected" ? `code=${settledErrorCode(acceptLoser.reason)}` : "no rejection found",
  );
  const matchedDetail = await learnerA.client.query(api.rooms.roomBookingDetail, { bookingId: nowReq.bookingId });
  check(
    "the request ends up matched to exactly one of the two partners",
    matchedDetail.status === "matched" && (matchedDetail.partnerId === partnerA.userId || matchedDetail.partnerId === partnerB.userId),
  );

  // -------------------------------------------------------------------------
  section("Rooms: eligibility filtering (language, level, availability/heartbeat)");
  // -------------------------------------------------------------------------
  const enReq = await learnerA.client.mutation(api.rooms.requestRoomNow, {
    scenario: "language filter test",
    minutes: 5,
    targetLanguage: "en",
  });
  const enVisibleToPartnerB = await partnerB.client.query(api.rooms.openNowRequests, {});
  check(
    "a partner with no \"en\" profile does not see an \"en\" request (only their \"de\" profile is approved)",
    !enVisibleToPartnerB.some((r) => r._id === enReq.bookingId),
  );

  runConvexCli(["run", "dev:seedRoomLearner", JSON.stringify({ userId: learnerA.userId, level: "intermediate" })]);
  runConvexCli([
    "run",
    "dev:seedPartnerProfile",
    JSON.stringify({ userId: partnerA.userId, targetLanguage: "de", level: "basic", availableNow: true }),
  ]);
  const levelReq = await learnerA.client.mutation(api.rooms.requestRoomNow, {
    scenario: "level filter test",
    minutes: 5,
    targetLanguage: "de",
  });
  const visibleAtLowLevel = await partnerA.client.query(api.rooms.openNowRequests, {});
  check(
    "a partner below the learner's level does not see the request",
    !visibleAtLowLevel.some((r) => r._id === levelReq.bookingId),
  );

  runConvexCli([
    "run",
    "dev:seedPartnerProfile",
    JSON.stringify({ userId: partnerA.userId, targetLanguage: "de", level: "confident", availableNow: true }),
  ]);
  const visibleAfterLevelUpgrade = await partnerA.client.query(api.rooms.openNowRequests, {});
  check(
    "the same partner sees it once their level is high enough",
    visibleAfterLevelUpgrade.some((r) => r._id === levelReq.bookingId),
  );

  await partnerA.client.mutation(api.partners.setAvailableNow, { targetLanguage: "de", available: false });
  const visibleWhenOffline = await partnerA.client.query(api.rooms.openNowRequests, {});
  check(
    "an eligible partner who is not \"available now\" does not see the request",
    !visibleWhenOffline.some((r) => r._id === levelReq.bookingId),
  );
  await expectThrow(
    "acceptRoomRequest is refused server-side when not available now — not just hidden from the list",
    () => partnerA.client.mutation(api.rooms.acceptRoomRequest, { bookingId: levelReq.bookingId }),
  );

  await partnerA.client.mutation(api.partners.setAvailableNow, { targetLanguage: "de", available: true });
  const visibleAgain = await partnerA.client.query(api.rooms.openNowRequests, {});
  check("marking available again restores visibility", visibleAgain.some((r) => r._id === levelReq.bookingId));

  // -------------------------------------------------------------------------
  section("Rooms: server-side price — a client cannot supply an amount at all");
  // -------------------------------------------------------------------------
  let rejectedExtraAmount = false;
  try {
    // Bypasses this script's own TS types on purpose: proves Convex's RUNTIME arg
    // validator rejects "amount" (it is no longer a declared arg), not just that
    // our own TypeScript happens to disallow writing it.
    await learnerA.client.action(api.payments.createOrder as any, {
      purpose: "room_booking",
      refId: levelReq.bookingId,
      amount: 1,
    });
  } catch {
    rejectedExtraAmount = true;
  }
  check(
    "Convex's own runtime validator rejects an unexpected \"amount\" argument on createOrder",
    rejectedExtraAmount,
  );

  // -------------------------------------------------------------------------
  section("Live room: setup — a fresh confirmed booking + a fixed script (no LLM, no payment)");
  // -------------------------------------------------------------------------
  const liveBookingId = JSON.parse(
    runConvexCli([
      "run",
      "dev:seedRoomBookingForTest",
      JSON.stringify({
        learnerId: learnerA.userId,
        partnerId: partnerA.userId,
        partnerProfileId: partnerAProfile._id,
        targetLanguage: "de",
        learnerLevel: "intermediate",
        minutes: 10,
        startInMs: 0,
      }),
    ]),
  ) as Id<"roomBookings">;
  const liveScriptLines = [
    { role: "partner", text: "Guten Tag, wie kann ich Ihnen helfen?", words: [] },
    { role: "learner", text: "Ich haette gerne einen Kaffee bitte", words: ["Kaffee"] },
    { role: "partner", text: "Gerne, sonst noch etwas?", words: [] },
    { role: "learner", text: "Nein danke das ist alles", words: [] },
  ];
  runConvexCli(["run", "dev:seedRoomScript", JSON.stringify({ bookingId: liveBookingId, lines: liveScriptLines })]);
  check("live room test booking seeded as \"confirmed\"", typeof liveBookingId === "string");

  // -------------------------------------------------------------------------
  section("Live room: joins rejected for strangers and outside the time window");
  // -------------------------------------------------------------------------
  await expectThrow("joinRoom rejects a user who is neither the learner nor the partner", () =>
    learnerB.client.action(api.liveRoom.joinRoom, { bookingId: liveBookingId }),
  );

  runConvexCli([
    "run",
    "dev:confirmRoomBookingForTest",
    JSON.stringify({ bookingId: liveBookingId, startInMs: 30 * 60_000, minutes: 10 }),
  ]);
  await expectThrow("joinRoom rejects joining more than 5 minutes before the scheduled start", () =>
    learnerA.client.action(api.liveRoom.joinRoom, { bookingId: liveBookingId }),
  );
  // Reset to a valid, immediate window for the rest of this section (the script survives — only booking fields are reset).
  runConvexCli(["run", "dev:confirmRoomBookingForTest", JSON.stringify({ bookingId: liveBookingId, startInMs: 0, minutes: 10 })]);

  // -------------------------------------------------------------------------
  section("Live room: real LiveKit tokens for both roles, cryptographically verified");
  // -------------------------------------------------------------------------
  const learnerJoin = await learnerA.client.action(api.liveRoom.joinRoom, { bookingId: liveBookingId });
  const partnerJoin = await partnerA.client.action(api.liveRoom.joinRoom, { bookingId: liveBookingId });
  check("joinRoom (learner): identity is \"learner:<userId>\"", learnerJoin.identity === `learner:${learnerA.userId}`);
  check("joinRoom (partner): identity is \"partner:<userId>\"", partnerJoin.identity === `partner:${partnerA.userId}`);

  const livekitApiKey = runConvexCli(["env", "get", "LIVEKIT_API_KEY"]).trim();
  const livekitApiSecret = runConvexCli(["env", "get", "LIVEKIT_API_SECRET"]).trim();
  const verifier = new TokenVerifier(livekitApiKey, livekitApiSecret);
  const learnerClaims = await verifier.verify(learnerJoin.token);
  const partnerClaims = await verifier.verify(partnerJoin.token);
  check(
    "learner token verifies against the real LiveKit API secret, room = bookingId, audio-only publish grant",
    learnerClaims.sub === learnerJoin.identity &&
      learnerClaims.video?.room === liveBookingId &&
      learnerClaims.video?.roomJoin === true &&
      JSON.stringify(learnerClaims.video?.canPublishSources) === JSON.stringify(["microphone"]),
    `sub=${learnerClaims.sub} room=${learnerClaims.video?.room}`,
  );
  check(
    "partner token verifies against the real LiveKit API secret, same room",
    partnerClaims.sub === partnerJoin.identity && partnerClaims.video?.room === liveBookingId,
    `sub=${partnerClaims.sub} room=${partnerClaims.video?.room}`,
  );

  const stateAfterBothJoined = await learnerA.client.query(api.liveRoom.roomState, { bookingId: liveBookingId });
  check(
    "booking flips to \"in_progress\" once both have joined",
    stateAfterBothJoined.status === "in_progress" && stateAfterBothJoined.learnerJoined && stateAfterBothJoined.partnerJoined,
  );

  // -------------------------------------------------------------------------
  section("Live room: speaker role comes from auth, and line matching advances correctly");
  // -------------------------------------------------------------------------
  await partnerA.client.mutation(api.liveRoom.saveRoomTurn, {
    bookingId: liveBookingId,
    transcript: "Guten Tag, wie kann ich Ihnen helfen?",
    words: [],
    startMs: 0,
    endMs: 2000,
  });
  const turnsAfterPartner = await partnerA.client.query(api.liveRoom.recentTurns, { bookingId: liveBookingId });
  check(
    "the saved turn is attributed to \"partner\" from auth, though nothing in the args says so",
    turnsAfterPartner.length === 1 && turnsAfterPartner[0]!.role === "partner",
  );
  let rejectedClientSuppliedRole = false;
  try {
    // Bypasses this script's own TS types on purpose — proves the runtime arg validator has no "role" field at all.
    await (learnerA.client.mutation as any)(api.liveRoom.saveRoomTurn, {
      bookingId: liveBookingId,
      transcript: "irrelevant",
      words: [],
      startMs: 0,
      endMs: 1000,
      role: "partner",
    });
  } catch {
    rejectedClientSuppliedRole = true;
  }
  check("saveRoomTurn's runtime validator rejects an unexpected \"role\" argument", rejectedClientSuppliedRole);

  const stateBeforeLearnerLine = await learnerA.client.query(api.liveRoom.roomState, { bookingId: liveBookingId });
  check("roomState: the next expected line is the first learner line (index 1)", stateBeforeLearnerLine.currentLineIndex === 1);

  const unrelatedTurn = await learnerA.client.mutation(api.liveRoom.saveRoomTurn, {
    bookingId: liveBookingId,
    transcript: "What time does the train leave",
    words: [],
    startMs: 2000,
    endMs: 4000,
  });
  check("an unrelated learner turn does not match the expected line", unrelatedTurn.matchedLineIndex === null);

  const matchingTurn = await learnerA.client.mutation(api.liveRoom.saveRoomTurn, {
    bookingId: liveBookingId,
    transcript: "Ich haette gerne einen Kaffee bitte",
    words: [{ text: "Kaffee", confidence: 0.93, start: 4200, end: 4600 }],
    startMs: 4000,
    endMs: 6000,
  });
  check(
    "a matching learner turn advances the script and records the target word said",
    matchingTurn.matchedLineIndex === 1 && matchingTurn.targetWordsSaid.some((w) => w.word === "Kaffee" && w.confidence > 0),
  );
  const stateAfterMatch = await learnerA.client.query(api.liveRoom.roomState, { bookingId: liveBookingId });
  check(
    "roomState: the current line advanced past the matched one, and the word shows up in targetWordsSaid",
    stateAfterMatch.currentLineIndex === 3 &&
      stateAfterMatch.doneLineIndices.includes(1) &&
      stateAfterMatch.targetWordsSaid.some((w) => w.word === "Kaffee"),
  );

  // -------------------------------------------------------------------------
  section("Live room: stuck cue is set after real silence following a partner line, and clears on the next learner turn");
  // -------------------------------------------------------------------------
  await partnerA.client.mutation(api.liveRoom.saveRoomTurn, {
    bookingId: liveBookingId,
    transcript: "Gerne, sonst noch etwas?",
    words: [],
    startMs: 6000,
    endMs: 8000,
  });
  const tooSoon = await learnerA.client.mutation(api.liveRoom.reportSilence, { bookingId: liveBookingId, seconds: 8 });
  check("reportSilence: not yet stuck when the real elapsed time is too short", tooSoon.stuckCue === false);
  await new Promise((resolve) => setTimeout(resolve, 8_500));
  const nowStuck = await learnerA.client.mutation(api.liveRoom.reportSilence, { bookingId: liveBookingId, seconds: 8 });
  check("reportSilence: stuck once >=8s have really passed since the partner's line", nowStuck.stuckCue === true);
  const stuckState = await partnerA.client.query(api.liveRoom.roomState, { bookingId: liveBookingId });
  check("roomState shows the stuck cue to the partner's screen", stuckState.stuckCue === true);

  await learnerA.client.mutation(api.liveRoom.saveRoomTurn, {
    bookingId: liveBookingId,
    transcript: "Nein danke das ist alles",
    words: [],
    startMs: 8000,
    endMs: 10_000,
  });
  const clearedState = await partnerA.client.query(api.liveRoom.roomState, { bookingId: liveBookingId });
  check("the stuck cue clears on the next learner turn", clearedState.stuckCue === false);

  // -------------------------------------------------------------------------
  section("Live room: strike 1 warns both sides, strike 2 ends the room with the violator recorded");
  // -------------------------------------------------------------------------
  const strikeBookingId = JSON.parse(
    runConvexCli([
      "run",
      "dev:seedRoomBookingForTest",
      JSON.stringify({
        learnerId: learnerA.userId,
        partnerId: partnerA.userId,
        partnerProfileId: partnerAProfile._id,
        targetLanguage: "de",
        learnerLevel: "intermediate",
        minutes: 10,
        startInMs: 0,
      }),
    ]),
  ) as Id<"roomBookings">;
  await learnerA.client.action(api.liveRoom.joinRoom, { bookingId: strikeBookingId });
  await partnerA.client.action(api.liveRoom.joinRoom, { bookingId: strikeBookingId });

  await partnerA.client.mutation(api.liveRoom.saveRoomTurn, {
    bookingId: strikeBookingId,
    transcript: "you filthy nigger",
    words: [],
    startMs: 0,
    endMs: 1000,
  });
  const afterStrike1 = await learnerA.client.query(api.liveRoom.roomState, { bookingId: strikeBookingId });
  check(
    "strike 1: the room stays open, a warning names the violating role",
    afterStrike1.status === "in_progress" && afterStrike1.otherStrikes === 1 && afterStrike1.warning?.role === "partner",
    `status=${afterStrike1.status} otherStrikes=${afterStrike1.otherStrikes} warningRole=${afterStrike1.warning?.role}`,
  );

  await partnerA.client.mutation(api.liveRoom.saveRoomTurn, {
    bookingId: strikeBookingId,
    transcript: "you filthy nigger again",
    words: [],
    startMs: 1000,
    endMs: 2000,
  });
  const afterStrike2 = await learnerA.client.query(api.liveRoom.roomState, { bookingId: strikeBookingId });
  check(
    "strike 2: the booking ends with \"ended_violation\" and the violator's role recorded",
    afterStrike2.status === "ended_violation" && afterStrike2.endedReason === "ended_violation" && afterStrike2.violatorRole === "partner",
    `status=${afterStrike2.status} violatorRole=${afterStrike2.violatorRole}`,
  );
  await expectThrow("a turn can no longer be saved once the room has ended on a violation", () =>
    partnerA.client.mutation(api.liveRoom.saveRoomTurn, { bookingId: strikeBookingId, transcript: "hello", words: [], startMs: 2000, endMs: 3000 }),
  );

  // Cleanup: cancel the still-open test requests (none were ever paid, so no Razorpay call is made).
  for (const [client, bookingId] of [
    [learnerA.client, enReq.bookingId],
    [learnerA.client, levelReq.bookingId],
  ] as const) {
    await client.action(api.rooms.cancelBooking, { bookingId }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("SpeakUp by AdaptiveSkills — verification (no LLM Gateway access required)");
  console.log("=".repeat(70));
  await partA();
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
