"use client";

import { useState } from "react";
import { useI18n } from "@/i18n/provider";
import { cx } from "@/components/ui";
import { LiveMic, type LiveMicResult } from "@/components/live-mic/live-mic";
import type { SpeechLang } from "@/lib/speech";

export type Answer = { index: number; spokenTranscript?: string };

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

/** Finds the option a spoken transcript most likely named — an aid for the mic input, not the grading itself (grading only ever uses `index`). */
export function matchOptionIndex(transcript: string, options: readonly string[]): number | null {
  const heard = normalize(transcript);
  if (heard.length === 0) return null;
  const heardTokens = new Set(heard.split(/\s+/).filter(Boolean));
  for (let i = 0; i < options.length; i++) {
    const optionTokens = normalize(options[i]!).split(/\s+/).filter(Boolean);
    if (optionTokens.length > 0 && optionTokens.every((tok) => heardTokens.has(tok))) return i;
  }
  for (let i = 0; i < options.length; i++) {
    if (heard.includes(normalize(options[i]!))) return i;
  }
  return null;
}

/** A fill-the-blank sentence: tap an option, or speak it (LiveMic, compact) — the shared mechanic behind both the grammar check and the story. */
export function AnswerPicker({
  sentence,
  meaning,
  options,
  answer,
  onAnswer,
  targetLang,
  disabled,
}: {
  sentence: string;
  meaning: string;
  options: readonly string[];
  answer: Answer | null;
  onAnswer: (answer: Answer) => void;
  targetLang: SpeechLang;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [heard, setHeard] = useState<string | null>(null);
  const [micKey, setMicKey] = useState(0);

  const parts = sentence.split("___");
  const blankText = answer !== null ? options[answer.index] : null;

  function pick(index: number) {
    if (disabled) return;
    onAnswer({ index });
    setHeard(null);
  }

  function onMicFinal(result: LiveMicResult) {
    setHeard(result.transcript);
    const matched = matchOptionIndex(result.transcript, options);
    if (matched !== null && !disabled) onAnswer({ index: matched, spokenTranscript: result.transcript });
    // A brief reset so the compact mic returns to its idle pill for another attempt.
    setMicKey((k) => k + 1);
  }

  return (
    <div>
      <p className="text-[22px] leading-snug font-semibold break-words">
        {parts[0]}
        <span
          className={cx(
            "mx-1 inline-block min-w-16 rounded-lg border-b-2 px-2 text-center align-baseline",
            blankText !== null ? "border-accent text-accent" : "border-line-strong text-muted",
          )}
        >
          {blankText ?? "___"}
        </span>
        {parts.slice(1).join("___")}
      </p>
      <p className="mt-2 text-base text-muted break-words">{meaning}</p>

      <div className="mt-5 grid grid-cols-2 gap-3">
        {options.map((option, i) => {
          const selected = answer?.index === i;
          return (
            <button
              key={`${option}-${i}`}
              type="button"
              disabled={disabled}
              onClick={() => pick(i)}
              aria-pressed={selected}
              className={cx(
                "min-h-14 rounded-2xl border px-3 text-[17px] font-semibold break-words transition-colors disabled:cursor-default",
                selected ? "border-accent bg-accent/15 text-fg" : "border-line-strong bg-surface text-fg hover:border-accent",
              )}
            >
              {option}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        <LiveMic
          key={micKey}
          purpose="target"
          variant="compact"
          stopOn="first-turn"
          settleMs={300}
          compactLabel={t("mic.speakInstead")}
          onFinal={onMicFinal}
          disabled={disabled}
        />
        {heard !== null ? <p className="mt-2 text-base text-muted">{t("lab.story.micHeard", { text: heard })}</p> : null}
      </div>
    </div>
  );
}
