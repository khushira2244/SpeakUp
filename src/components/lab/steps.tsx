"use client";

import { useI18n } from "@/i18n/provider";
import { BackButton, BrandHeader, PrimaryButton, Screen } from "@/components/ui";
import { SpeakButton } from "@/components/home/sheet";
import type { SpeechLang } from "@/lib/speech";
import { useSpeech } from "@/lib/speech";
import { AnswerPicker, type Answer } from "./answer-picker";

type LearnWord = { word: string; meaning: string; pronunciationHint: string | null };
type LearnPattern = { pattern: string; example: string; meaning: string };

function SpeakerSlowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" />
      <path d="M16 12h4M16 9v6" />
    </svg>
  );
}

/** Screen 1: today's words + pattern, with normal/slow listening. No attempt yet — just study. */
export function LearnStep({
  words,
  patterns,
  targetLang,
  onStart,
  onBack,
}: {
  words: LearnWord[];
  patterns: LearnPattern[];
  targetLang: SpeechLang;
  onStart: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const { speak } = useSpeech();

  return (
    <Screen>
      <div className="relative">
        <BackButton onClick={onBack} />
        <BrandHeader tagline={false} />
      </div>
      <h2 className="mt-4 text-[22px] font-bold">{t("lab.learn.title")}</h2>

      <p className="mt-5 text-base font-semibold text-muted">{t("lab.learn.wordsTitle")}</p>
      <ul className="mt-2 divide-y divide-line rounded-2xl border border-line bg-surface">
        {words.map((w) => (
          <li key={w.word} className="flex items-center gap-2 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[18px] font-semibold break-words">{w.word}</p>
              {w.pronunciationHint ? <p className="text-base text-muted">{w.pronunciationHint}</p> : null}
              <p className="text-base break-words text-muted">{w.meaning}</p>
            </div>
            <button
              type="button"
              onClick={() => speak(w.word, targetLang, false)}
              aria-label={`${t("sheet.listen")}: ${w.word}`}
              className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-accent"
            >
              <SpeakButtonIcon />
            </button>
            <button
              type="button"
              onClick={() => speak(w.word, targetLang, true)}
              aria-label={`${t("sheet.listenSlow")}: ${w.word}`}
              className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-accent"
            >
              <SpeakerSlowIcon />
            </button>
          </li>
        ))}
      </ul>

      {patterns.length > 0 ? (
        <>
          <p className="mt-5 text-base font-semibold text-muted">{t("lab.learn.patternTitle")}</p>
          <ul className="mt-2 grid gap-3">
            {patterns.map((p) => (
              <li key={p.pattern} className="rounded-2xl border border-line bg-surface p-4">
                <p className="text-[18px] font-semibold break-words">{p.pattern}</p>
                <div className="mt-2 flex items-center gap-2">
                  <p className="min-w-0 flex-1 text-[18px] break-words">{p.example}</p>
                  <SpeakButton text={p.example} lang={targetLang} label={`${t("sheet.listen")}: ${p.example}`} />
                </div>
                <p className="mt-1 text-base break-words text-muted">{p.meaning}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="mt-auto pt-6">
        <PrimaryButton type="button" onClick={onStart}>
          {t("lab.learn.start")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}

function SpeakButtonIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" />
      <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />
    </svg>
  );
}

function ProgressBar({ index, total }: { index: number; total: number }) {
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={index} className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line">
      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${((index + 0.5) / total) * 100}%` }} />
    </div>
  );
}

/** Screens 2 & 3 share this shape: progress, a fill-the-blank sentence, Next/Finish. */
export function AttemptStep({
  titleKey,
  progressLabel,
  instructionKey,
  index,
  total,
  sentence,
  meaning,
  options,
  answer,
  onAnswer,
  targetLang,
  isLast,
  onNext,
  onBack,
}: {
  titleKey: "lab.grammar.title" | "lab.story.title";
  progressLabel: string;
  instructionKey: "lab.grammar.instruction" | "lab.story.instruction";
  index: number;
  total: number;
  sentence: string;
  meaning: string;
  options: readonly string[];
  answer: Answer | null;
  onAnswer: (answer: Answer) => void;
  targetLang: SpeechLang;
  isLast: boolean;
  onNext: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  return (
    <Screen>
      <div className="relative">
        <BackButton onClick={onBack} />
        <BrandHeader tagline={false} />
      </div>
      <h2 className="mt-4 text-[22px] font-bold">{t(titleKey)}</h2>
      <p className="mt-3 text-base text-muted">{progressLabel}</p>
      <ProgressBar index={index} total={total} />

      <p className="mt-4 text-base text-muted">{t(instructionKey)}</p>
      <section className="mt-3 rounded-2xl border border-line bg-surface p-4">
        <AnswerPicker sentence={sentence} meaning={meaning} options={options} answer={answer} onAnswer={onAnswer} targetLang={targetLang} />
      </section>

      <div className="mt-auto pt-6">
        <PrimaryButton type="button" disabled={answer === null} onClick={onNext}>
          {isLast ? t("lab.story.finish") : t("lab.grammar.next")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}
