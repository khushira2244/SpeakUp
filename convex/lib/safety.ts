/**
 * Two-stage in-room safety check: a fast, deterministic rule check first
 * (this file), then an LLM Gateway classification only for the "borderline"
 * tier — never for a clear hit, and never for a clean transcript.
 *
 * The word lists below are a small, deliberately conservative STARTING POINT
 * (common, unambiguous profanity/hate-speech/harassment terms per language),
 * not a maintained moderation corpus — a real deployment should swap these
 * for a vetted provider list or service. They exist so the two-tier mechanism
 * (hard hit -> immediate strike, soft hit -> LLM confirmation) has real
 * "hard"/"soft" terms to exercise; the mechanism, not the exact wordlist, is
 * the point of this module.
 *
 * No Convex imports (pure), so scripts/verify.ts can test `ruleCheck`
 * directly — matching lib/rooms.ts / lib/liveRoom.ts's convention.
 */

import { matchTokens } from "./languages";

export type SafetyLanguage = "en" | "de" | "hi" | "te";
export type RuleFlag = "safe" | "borderline" | "violation";

/**
 * Clear, unambiguous hits: slurs, explicit sexual harassment, direct threats
 * of violence. A hit here is a strike with no LLM step — see convex/liveRoom.ts.
 */
const HARD_BLOCKLIST: Record<SafetyLanguage, string[]> = {
  en: ["nigger", "nigga", "faggot", "retard", "cunt", "kill yourself", "kys"],
  de: ["neger", "schwuchtel", "bring dich um"],
  hi: ["chutiya", "randi", "bhosdike", "madarchod", "behenchod"],
  te: ["lanja", "pooku", "dengey"],
};

/**
 * Ambiguous on their own — could be joking, frustrated, or genuinely hostile.
 * A hit here schedules an LLM Gateway classification; the turn still saves
 * immediately either way (see convex/liveRoom.ts saveRoomTurn).
 */
const SOFT_BLOCKLIST: Record<SafetyLanguage, string[]> = {
  en: ["shut up", "idiot", "stupid", "shit", "damn", "hate you", "ugly"],
  de: ["idiot", "dumm", "halt die klappe", "hässlich"],
  hi: ["chup", "bewakoof", "pagal", "ganda"],
  te: ["waste fellow", "పిచ్చోడు", "వెధవ"],
};

function hitsAny(tokens: ReadonlySet<string>, phrases: readonly string[]): boolean {
  for (const phrase of phrases) {
    const phraseTokens = matchTokens(phrase);
    if (phraseTokens.length === 0) continue;
    if (phraseTokens.length === 1) {
      if (tokens.has(phraseTokens[0]!)) return true;
      continue;
    }
    // Multi-word phrase: every one of its tokens must be present (cheap
    // approximation — good enough for a small blocklist; adjacency is not
    // checked, so this can over-match slightly, never under-match).
    if (phraseTokens.every((t) => tokens.has(t))) return true;
  }
  return false;
}

const ALL_SAFETY_LANGUAGES: readonly SafetyLanguage[] = ["en", "de", "hi", "te"];

/** Deterministic, no LLM. Normalizes/tokenizes the same way scoring.ts matches goal words. */
export function ruleCheck(transcript: string, language: SafetyLanguage): RuleFlag {
  const tokens = new Set(matchTokens(transcript));
  if (tokens.size === 0) return "safe";
  if (hitsAny(tokens, HARD_BLOCKLIST[language])) return "violation";
  if (hitsAny(tokens, SOFT_BLOCKLIST[language])) return "borderline";
  return "safe";
}

/**
 * Checks a transcript against EVERY language's blocklist, not just the room's
 * target language — a speaker who code-switches into their own language when
 * upset (or just says something in a language other than the one they are
 * practicing) should not slip past moderation because of which box the
 * booking happens to be in. Returns the most severe outcome across all four.
 * Used by liveRoom.saveRoomTurn; `ruleCheck` above stays the single-language
 * primitive (and is what scripts/verify.ts's Part A tests exercise directly).
 */
export function ruleCheckAnyLanguage(transcript: string): RuleFlag {
  const tokens = new Set(matchTokens(transcript));
  if (tokens.size === 0) return "safe";
  let worst: RuleFlag = "safe";
  for (const language of ALL_SAFETY_LANGUAGES) {
    if (hitsAny(tokens, HARD_BLOCKLIST[language])) return "violation"; // already the worst possible outcome
    if (worst === "safe" && hitsAny(tokens, SOFT_BLOCKLIST[language])) worst = "borderline";
  }
  return worst;
}

// ---------------------------------------------------------------------------
// LLM classification (borderline tier only)
// ---------------------------------------------------------------------------

export const SAFETY_SYSTEM_PROMPT = `You are a content-safety classifier for a language-learning speaking practice app.
Two strangers are practicing a conversation out loud; the transcript may be informal, include filler words, or be a mis-transcription.
Decide only whether the SPEAKER's turn is a genuine safety violation (harassment, hate speech, sexual harassment, or a threat directed at the other person) versus harmless language (mild frustration, a joke, an unrelated word that only sounds similar, or a transcription glitch).
Return strict JSON only.`;

export const SAFETY_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["safe", "violation"] },
    reason: { type: "string" },
  },
  required: ["verdict", "reason"],
  additionalProperties: false,
};

export type SafetyVerdict = { verdict: "safe" | "violation"; reason: string };

export function safetyUserPrompt(transcript: string, language: SafetyLanguage): string {
  return `Language being spoken: ${language}\nTranscript of the turn: "${transcript}"\n\nIs this a genuine safety violation? Return { "verdict": "safe" | "violation", "reason": "<one short sentence>" }.`;
}

export function validateSafetyVerdict(raw: unknown): SafetyVerdict {
  if (typeof raw !== "object" || raw === null) throw new Error("safety verdict: expected an object");
  const obj = raw as Record<string, unknown>;
  if (obj.verdict !== "safe" && obj.verdict !== "violation") {
    throw new Error(`safety verdict: "verdict" must be "safe" or "violation", got ${JSON.stringify(obj.verdict)}`);
  }
  if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
    throw new Error("safety verdict: \"reason\" must be a non-empty string");
  }
  return { verdict: obj.verdict, reason: obj.reason.trim().slice(0, 500) };
}
