"use client";

import { useState } from "react";
import { useI18n } from "@/i18n/provider";
import { BackButton, BrandHeader, PrimaryButton, Screen, cx } from "@/components/ui";
import { LiveMic } from "@/components/live-mic/live-mic";
import { useSpeech, type SpeechLang } from "@/lib/speech";

export type CorrectionItem = {
  key: string;
  /** The sentence with the blank already replaced by the correct word (never "___" here — correction always shows the answer). */
  sentence: string;
  meaning: string;
  correct: boolean;
};

function CheckBadge() {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-accent-ink" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    </span>
  );
}

function XBadge() {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-danger/20 text-danger" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </span>
  );
}

function SpeakIconButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-accent">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" />
        <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />
      </svg>
    </button>
  );
}

function CorrectionRow({ item, targetLang }: { item: CorrectionItem; targetLang: SpeechLang }) {
  const { t } = useI18n();
  const { speak } = useSpeech();
  const [repeated, setRepeated] = useState(false);

  return (
    <li className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-start gap-2">
        {item.correct ? <CheckBadge /> : <XBadge />}
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-muted">{item.correct ? t("lab.correction.correct") : t("lab.correction.wrong")}</p>
          <div className="mt-1 flex items-center gap-1">
            <p className="min-w-0 flex-1 text-[18px] leading-snug break-words">{item.sentence}</p>
            <SpeakIconButton onClick={() => speak(item.sentence, targetLang, false)} label={t("sheet.listen")} />
          </div>
          <p className="mt-1 text-base break-words text-muted">{item.meaning}</p>
        </div>
      </div>

      {!item.correct ? (
        <div className="mt-3 border-t border-line pt-3">
          {repeated ? (
            <p className="flex items-center gap-2 text-base font-semibold text-accent">
              <CheckBadge />
              {t("lab.correction.repeatDone")}
            </p>
          ) : (
            <div className="flex items-center gap-3">
              <p className="text-base text-muted">{t("lab.correction.repeatPrompt")}</p>
              <LiveMic
                purpose="target"
                variant="compact"
                stopOn="first-turn"
                settleMs={300}
                onFinal={() => setRepeated(true)}
              />
              <button type="button" onClick={() => setRepeated(true)} className="text-base text-muted underline underline-offset-2">
                {t("lab.correction.repeatSkip")}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function CorrectionStep({
  items,
  targetLang,
  pass,
  correctCount,
  totalCount,
  onContinue,
  onBack,
}: {
  items: CorrectionItem[];
  targetLang: SpeechLang;
  pass: boolean;
  correctCount: number;
  totalCount: number;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  return (
    <Screen>
      <div className="relative">
        <BackButton onClick={onBack} />
        <BrandHeader tagline={false} />
      </div>
      <h2 className="mt-4 text-[22px] font-bold">{t("lab.correction.title")}</h2>

      <ul className="mt-4 flex flex-col gap-3">
        {items.map((item) => (
          <CorrectionRow key={item.key} item={item} targetLang={targetLang} />
        ))}
      </ul>

      <div className={cx("mt-4 rounded-2xl border p-4 text-center", pass ? "border-accent/50 bg-accent/10" : "border-line bg-surface")}>
        <p className="text-[17px] font-semibold">{t(pass ? "lab.correction.summaryPass" : "lab.correction.summaryNotYet", { correct: correctCount, total: totalCount })}</p>
      </div>

      <div className="mt-4 pb-4">
        <PrimaryButton type="button" onClick={onContinue}>
          {t("lab.correction.continue")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}
