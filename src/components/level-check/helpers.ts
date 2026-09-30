import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";

export type ActiveGoal = NonNullable<FunctionReturnType<typeof api.goals.activeGoal>>;
export type LevelResultResponse = FunctionReturnType<typeof api.scoring.levelResult>;
export type LevelResult = NonNullable<LevelResultResponse["result"]>;
export type Level = LevelResult["level"];

export type LangCode = "en" | "de" | "hi" | "te";

/** The language of what was said, judged by script (Devanagari / Telugu) alone. */
export function scriptLanguage(text: string): "hi" | "te" | null {
  let devanagari = 0;
  let telugu = 0;
  let letters = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x0900 && cp <= 0x097f) devanagari++;
    else if (cp >= 0x0c00 && cp <= 0x0c7f) telugu++;
    else if (/\p{L}/u.test(ch)) letters++;
  }
  const total = devanagari + telugu + letters;
  if (total === 0) return null;
  if (devanagari / total >= 0.5) return "hi";
  if (telugu / total >= 0.5) return "te";
  return null;
}

function asLang(code: string | null | undefined): LangCode | null {
  const two = code?.slice(0, 2).toLowerCase();
  return two === "en" || two === "de" || two === "hi" || two === "te" ? two : null;
}

/**
 * The language the learner actually spoke, when it is NOT the target language
 * ("Can't answer? Speak in your language" is fine, and gets a friendly note).
 */
export function spokenOtherLanguage(
  text: string,
  detectedCode: string | null | undefined,
  target: "en" | "de",
): LangCode | null {
  const byScript = scriptLanguage(text);
  if (byScript) return byScript;
  const detected = asLang(detectedCode);
  return detected && detected !== target ? detected : null;
}

// ---------------------------------------------------------------------------
// Where the learner is, so a reload does not restart the check.
// ---------------------------------------------------------------------------

export type Snapshot = {
  goalId: string;
  levelCheckId: string;
  phase: "words" | "prompts" | "submitted";
  wordIndex: number;
  promptIndex: number;
};

const KEY = "speakup.levelcheck";

export function loadSnapshot(): Snapshot | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Snapshot>;
    if (
      typeof d.goalId === "string" &&
      typeof d.levelCheckId === "string" &&
      (d.phase === "words" || d.phase === "prompts" || d.phase === "submitted") &&
      Number.isInteger(d.wordIndex) &&
      Number.isInteger(d.promptIndex)
    ) {
      return d as Snapshot;
    }
  } catch {
    // unreadable: treat as none
  }
  return null;
}

export function saveSnapshot(snapshot: Snapshot): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    // storage blocked: the check still works, it just cannot resume after a reload
  }
}

export function clearSnapshot(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignored
  }
}
