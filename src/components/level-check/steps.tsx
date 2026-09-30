"use client";

import { useState, type ReactNode } from "react";
import type { Id } from "@convex/_generated/dataModel";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { BackButton, BrandHeader, Screen } from "@/components/ui";
import { LiveMic, type LiveMicError, type LiveMicResult } from "@/components/live-mic/live-mic";
import { scriptLanguage, type LangCode } from "./helpers";

/** Word attempt: read one word aloud. It is a test, so there is no 🔊 and no hint. */
export function WordStep({
  index,
  total,
  word,
  goalId,
  onFinal,
  onSkip,
  onBack,
  onError,
  footer,
}: {
  index: number;
  total: number;
  word: string;
  /** Stream for a specific owned goal (a partner's test) instead of the caller's active goal. */
  goalId?: Id<"goals">;
  onFinal: (result: LiveMicResult) => void;
  onSkip: () => void;
  onBack: () => void;
  onError: (code: LiveMicError) => void;
  /** Saving / error notice shown under the mic. */
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Screen>
      <div className="relative">
        <BackButton onClick={onBack} />
        <BrandHeader />
      </div>

      <p className="mt-8 text-center text-base text-muted">{t("lc.word.progress", { n: index + 1, total })}</p>

      <section className="mt-3 rounded-3xl border border-line bg-surface px-4 py-8 text-center">
        <p className="text-[36px] leading-tight font-bold break-words">
          {word}
        </p>
        <div className="mt-6">
          <LiveMic
            purpose="target"
            {...(goalId !== undefined ? { goalId } : {})}
            stopOn="first-turn"
            maxSeconds={10}
            settleMs={700}
            idleText={t("lc.word.tap")}
            listeningSubText={t("lc.word.speakNow")}
            doneTitle={t("lc.word.got")}
            doneText={t("lc.word.next")}
            onFinal={onFinal}
            onError={onError}
          />
        </div>
        {footer}
      </section>

      <div className="mt-auto pt-6 text-center">
        <button type="button" onClick={onSkip} className="h-11 px-4 text-base font-semibold text-accent">
          {t("lc.word.skip")}
        </button>
      </div>
    </Screen>
  );
}

/** Prompt attempt: answer a question by speaking, in either language. */
export function PromptStep({
  index,
  total,
  prompt,
  target,
  goalId,
  onFinal,
  onBack,
  onError,
  footer,
  previewLive,
}: {
  index: number;
  total: number;
  prompt: { english: string; native: string };
  target: "en" | "de";
  /** Stream for a specific owned goal (a partner's test) instead of the caller's active goal. */
  goalId?: Id<"goals">;
  onFinal: (result: LiveMicResult) => void;
  onBack: () => void;
  onError: (code: LiveMicError) => void;
  footer?: ReactNode;
  /** Development gallery only: pretend this was already heard. */
  previewLive?: string;
}) {
  const { t } = useI18n();
  const [live, setLive] = useState(previewLive ?? "");

  const other: LangCode | null = scriptLanguage(live);
  const label = other ? t("lc.prompt.answerIn", { lang: t(`langname.${other}` as MessageKey) }) : t("mic.youSaid");

  return (
    <Screen>
      <div className="relative">
        <BackButton onClick={onBack} />
        <BrandHeader />
      </div>

      <p className="mt-8 text-base text-muted">{t("lc.prompt.progress", { n: index + 1, total })}</p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={index}
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line"
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${((index + 0.5) / total) * 100}%` }} />
      </div>

      <section className="mt-4 rounded-2xl border border-line bg-surface p-4">
        <p className="text-[22px] leading-snug font-bold">{prompt.english}</p>
        <p className="mt-2 text-base text-muted">{prompt.native}</p>
      </section>

      <div className="mt-4">
        <LiveMic
          purpose="own"
          {...(goalId !== undefined ? { goalId } : {})}
          stopOn="manual"
          maxSeconds={60}
          transcriptLabel={label}
          onLive={setLive}
          onFinal={onFinal}
          onError={onError}
        />
      </div>

      {other ? (
        <div className="mt-4 flex items-start gap-3 rounded-2xl border border-accent/40 bg-accent/10 p-4">
          <span className="text-accent" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.4 1 2.5h6c0-1.1.3-1.8 1-2.5A6 6 0 0 0 12 3z" />
            </svg>
          </span>
          <p className="text-base">{t("lc.prompt.ownLangNote", { lang: t(`langname.${target}` as MessageKey) })}</p>
        </div>
      ) : null}

      {footer}
    </Screen>
  );
}
