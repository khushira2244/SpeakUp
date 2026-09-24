/**
 * Language model for SpeakUp: which languages a learner knows, which one the
 * app talks to them in, and which one they are learning — plus the pure,
 * deterministic text rules that depend on those languages.
 *
 *   knownLanguages   languages the learner already speaks ("en" | "hi" | "te")
 *   primaryLanguage  one of knownLanguages; used for UI text, meanings,
 *                    pronunciation hints and summaries
 *   targetLanguage   the language being learned ("en" | "de")
 *
 * Dependency-free (no Convex imports) so every rule here is unit-testable from
 * scripts/verify.ts without a deployment.
 */

export const KNOWN_LANGUAGES = ["en", "hi", "te"] as const;
export type KnownLanguage = (typeof KNOWN_LANGUAGES)[number];

export const TARGET_LANGUAGES = ["en", "de"] as const;
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<KnownLanguage | TargetLanguage, string> = {
  en: "English",
  hi: "Hindi",
  te: "Telugu",
  de: "German",
};

export type LanguageProfile = {
  knownLanguages: KnownLanguage[];
  primaryLanguage: KnownLanguage;
  targetLanguage: TargetLanguage;
};

export class LanguageProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LanguageProfileError";
  }
}

export function isKnownLanguage(value: unknown): value is KnownLanguage {
  return typeof value === "string" && (KNOWN_LANGUAGES as readonly string[]).includes(value);
}

export function isTargetLanguage(value: unknown): value is TargetLanguage {
  return typeof value === "string" && (TARGET_LANGUAGES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Profile rule
// ---------------------------------------------------------------------------

/**
 * Validates and normalises a language profile. Throws LanguageProfileError.
 *
 *   - knownLanguages: each one supported, de-duplicated (first occurrence
 *     wins), at least one left
 *   - primaryLanguage: must be one of knownLanguages
 *   - targetLanguage: supported, and NOT the learner's only known language
 *     (known ["en"] + target "en" is rejected; known ["en","hi"] + target "en"
 *     is allowed — the learner has another language to fall back on)
 */
export function normalizeLanguageProfile(input: {
  knownLanguages: readonly string[];
  primaryLanguage: string;
  targetLanguage: string;
}): LanguageProfile {
  const knownLanguages: KnownLanguage[] = [];
  for (const raw of input.knownLanguages) {
    if (!isKnownLanguage(raw)) {
      throw new LanguageProfileError(
        `Unsupported known language "${raw}". Supported: ${KNOWN_LANGUAGES.join(", ")}.`,
      );
    }
    if (!knownLanguages.includes(raw)) knownLanguages.push(raw);
  }
  if (knownLanguages.length === 0) {
    throw new LanguageProfileError("knownLanguages must contain at least one language.");
  }

  if (!isKnownLanguage(input.primaryLanguage)) {
    throw new LanguageProfileError(
      `Unsupported primary language "${input.primaryLanguage}". Supported: ${KNOWN_LANGUAGES.join(", ")}.`,
    );
  }
  if (!knownLanguages.includes(input.primaryLanguage)) {
    throw new LanguageProfileError(
      `primaryLanguage "${input.primaryLanguage}" must be one of knownLanguages (${knownLanguages.join(", ")}).`,
    );
  }

  if (!isTargetLanguage(input.targetLanguage)) {
    throw new LanguageProfileError(
      `Unsupported target language "${input.targetLanguage}". Supported: ${TARGET_LANGUAGES.join(", ")}.`,
    );
  }
  if (knownLanguages.length === 1 && knownLanguages[0] === input.targetLanguage) {
    throw new LanguageProfileError(
      `targetLanguage "${input.targetLanguage}" cannot be the only language you know. Add another known language or pick a different target.`,
    );
  }

  return {
    knownLanguages,
    primaryLanguage: input.primaryLanguage,
    targetLanguage: input.targetLanguage,
  };
}

/**
 * Reads a stored profile. Returns null when any part is unset (a user row
 * exists before updateProfile runs) or when stored values no longer validate.
 */
export function readLanguageProfile(fields: {
  knownLanguages?: readonly string[] | undefined;
  primaryLanguage?: string | undefined;
  targetLanguage?: string | undefined;
}): LanguageProfile | null {
  if (
    fields.knownLanguages === undefined ||
    fields.primaryLanguage === undefined ||
    fields.targetLanguage === undefined
  ) {
    return null;
  }
  try {
    return normalizeLanguageProfile({
      knownLanguages: fields.knownLanguages,
      primaryLanguage: fields.primaryLanguage,
      targetLanguage: fields.targetLanguage,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generation-language snapshot
// ---------------------------------------------------------------------------

/**
 * goalTargets rows written before the language snapshot existed came from the
 * original generator, which only ever produced ENGLISH words (with meanings in
 * the learner's then-nativeLanguage). "en" is therefore a fact for those rows,
 * not a guess.
 */
export const LEGACY_TARGET_LANGUAGE: TargetLanguage = "en";

/**
 * The languages a goalTargets row was generated in. Prefers the stored
 * snapshot; falls back to the legacy rule for pre-snapshot rows.
 */
export function generationLanguages(
  targets: { targetLanguage?: TargetLanguage | undefined; primaryLanguage?: KnownLanguage | undefined },
  profile: LanguageProfile | null,
): { targetLanguage: TargetLanguage; primaryLanguage: KnownLanguage; fromSnapshot: boolean } {
  const fromSnapshot =
    targets.targetLanguage !== undefined && targets.primaryLanguage !== undefined;
  return {
    targetLanguage: targets.targetLanguage ?? LEGACY_TARGET_LANGUAGE,
    primaryLanguage: targets.primaryLanguage ?? profile?.primaryLanguage ?? "en",
    fromSnapshot,
  };
}

// ---------------------------------------------------------------------------
// Legacy nativeLanguage -> profile backfill (widen-migrate-narrow, step b)
// ---------------------------------------------------------------------------

export type LegacyBackfillPlan =
  | { kind: "none" }
  | { kind: "migrate"; profile: LanguageProfile }
  | { kind: "unsupported"; legacyValue: string };

/**
 * Maps a legacy `nativeLanguage` value onto the new profile.
 *   "en" -> known ["en"], primary "en", target "de" (target "en" would break
 *           the "not the only known language" rule)
 *   "hi" / "te" -> known [x], primary x, target "en"
 *   anything else -> unsupported (new fields stay unset)
 *   unset -> none
 */
export function planLegacyLanguageBackfill(legacy: unknown): LegacyBackfillPlan {
  if (legacy === undefined || legacy === null) return { kind: "none" };
  if (typeof legacy !== "string") return { kind: "unsupported", legacyValue: String(legacy) };
  const value = legacy.trim().toLowerCase();
  if (!isKnownLanguage(value)) return { kind: "unsupported", legacyValue: legacy };
  return {
    kind: "migrate",
    profile: normalizeLanguageProfile({
      knownLanguages: [value],
      primaryLanguage: value,
      targetLanguage: value === "en" ? "de" : "en",
    }),
  };
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

export type Script = "Latin" | "Devanagari" | "Telugu";

/** The writing system each known language's hints and summaries use. */
export const SCRIPT_FOR_LANGUAGE: Record<KnownLanguage, Script> = {
  en: "Latin",
  hi: "Devanagari",
  te: "Telugu",
};

const SCRIPT_PATTERNS: Record<Script, RegExp> = {
  Latin: /\p{Script=Latin}/u,
  Devanagari: /\p{Script=Devanagari}/u,
  Telugu: /\p{Script=Telugu}/u,
};

const LETTER = /\p{L}/u;

function lettersOf(text: string): string[] {
  return Array.from(text).filter((ch) => LETTER.test(ch));
}

/**
 * True when `text` has at least one letter and EVERY letter belongs to
 * `script`. Spaces, punctuation, hyphens, digits and combining marks are
 * ignored, so "GOO-ten tahg" is Latin and "गूटेन टाग" is Devanagari.
 */
export function isWrittenInScript(text: string, script: Script): boolean {
  const letters = lettersOf(text);
  return letters.length > 0 && letters.every((ch) => SCRIPT_PATTERNS[script].test(ch));
}

export function containsScript(text: string, script: Script): boolean {
  return SCRIPT_PATTERNS[script].test(text);
}

/**
 * Own-language evidence from the writing system alone: Devanagari means Hindi,
 * Telugu script means Telugu. (English and German share the Latin script, so
 * they can only be told apart via a detected-language code.)
 */
export function ownLanguagesByScript(text: string): KnownLanguage[] {
  const found: KnownLanguage[] = [];
  if (containsScript(text, "Devanagari")) found.push("hi");
  if (containsScript(text, "Telugu")) found.push("te");
  return found;
}

// ---------------------------------------------------------------------------
// Pronunciation-hint prompt text (shared by generation and the hint backfill)
// ---------------------------------------------------------------------------

/** One worked example per target language, rendered in each learner script. */
const HINT_EXAMPLES: Record<TargetLanguage, { word: string; hint: Record<KnownLanguage, string> }> = {
  de: { word: "Guten Tag", hint: { hi: "गूटेन टाग", te: "గూటెన్ టాగ్", en: "GOO-ten tahg" } },
  en: { word: "doctor", hint: { hi: "डॉक्टर", te: "డాక్టర్", en: "DOK-ter" } },
};

/**
 * The instruction given to the LLM for a word's `pronunciationHint`. Worded to
 * match exactly what validatePronunciationHint enforces afterwards.
 */
export function pronunciationHintInstruction(
  target: TargetLanguage,
  primary: KnownLanguage,
): string {
  const example = HINT_EXAMPLES[target];
  if (primary === "en") {
    return `how the ${LANGUAGE_NAMES[target]} word SOUNDS, as a simple English sound-alike using only Latin letters, stressed syllable in CAPITALS (e.g. "${example.word}" -> "${example.hint.en}").`;
  }
  const script = SCRIPT_FOR_LANGUAGE[primary];
  return `how the ${LANGUAGE_NAMES[target]} word SOUNDS, written ONLY in ${script} script (${LANGUAGE_NAMES[primary]}) so the learner can read it aloud (e.g. "${example.word}" -> "${example.hint[primary]}"). Use no Latin letters at all, and never just copy the ${LANGUAGE_NAMES[target]} spelling.`;
}

// ---------------------------------------------------------------------------
// Matching normalisation (German-aware)
// ---------------------------------------------------------------------------

/**
 * Canonical form for word matching across en / de / hi / te:
 *   - NFC, so a decomposed "u + U+0308" and a precomposed "ü" are identical
 *   - typographic apostrophes folded to "'"
 *   - lower-cased (German nouns are capitalised; ASR output often is not)
 *   - German: ß / ẞ -> "ss"; ä ö ü -> "ae" "oe" "ue"
 *
 * Umlauts are EXPANDED rather than stripped on purpose. "ae/oe/ue" is the
 * standard German substitute spelling, so "für" ≡ "fuer" and "Straße" ≡
 * "Strasse" — but stripping would merge real minimal pairs such as
 * "schon" (already) and "schön" (beautiful), which must stay distinct.
 */
export function foldForMatching(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/ẞ/g, "ß") // ẞ -> ß
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue");
}

/**
 * Unicode-aware tokens: runs of letters, combining marks and digits (marks are
 * essential — Devanagari and Telugu vowel signs are combining marks, and
 * dropping them would mangle every Hindi or Telugu word). Apostrophes inside a
 * word ("don't") are kept; quote-style apostrophes at the edges are trimmed.
 */
export function matchTokens(text: string): string[] {
  const runs = foldForMatching(text).match(/[\p{L}\p{M}\p{N}']+/gu) ?? [];
  return runs.map((run) => run.replace(/^'+|'+$/g, "")).filter((run) => run.length > 0);
}

// ---------------------------------------------------------------------------
// Streaming model routing
// ---------------------------------------------------------------------------

/**
 * AssemblyAI v3 streaming `speech_model` values. Both were confirmed against
 * the live endpoint (it rejects unknown values with an enumerated error):
 *   u3-rt-pro   Universal-3 Pro streaming — English and German
 *   whisper-rt  Whisper streaming — auto language detection, no language
 *               parameter; the only streaming option that plausibly covers
 *               Telugu (the current Universal-3.5 Pro docs do not list "te")
 */
export const STREAM_MODEL_TARGET = "u3-rt-pro";
export const STREAM_MODEL_OWN_LANGUAGE = "whisper-rt";

export type StreamPurpose = "target" | "own";

/**
 *   target -> the learner is speaking targetLanguage (en or de): u3-rt-pro
 *   own    -> the learner is answering in their own (primary) language:
 *             hi / te -> whisper-rt; en -> same model as the target language
 */
export function streamRouteFor(
  purpose: StreamPurpose,
  languages: { targetLanguage: TargetLanguage; primaryLanguage: KnownLanguage },
): { language: KnownLanguage | TargetLanguage; speechModel: string } {
  if (purpose === "target") {
    return { language: languages.targetLanguage, speechModel: STREAM_MODEL_TARGET };
  }
  if (languages.primaryLanguage === "en") {
    return { language: "en", speechModel: STREAM_MODEL_TARGET };
  }
  return { language: languages.primaryLanguage, speechModel: STREAM_MODEL_OWN_LANGUAGE };
}
