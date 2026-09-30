"use client";

import { useState } from "react";
import { useI18n } from "@/i18n/provider";
import { BackButton, BrandHeader, PrimaryButton, Screen, cx } from "@/components/ui";
import { LiveMic } from "@/components/live-mic/live-mic";
import { useSpeech, type SpeechLang } from "@/lib/speech";

export type SpeakingSentence = { key: string; text: string; meaning: string };

/**
 * Screen 5: optional speaking through the completed sentences. This is
 * pronunciation practice/reinforcement, not re-graded — the lab's own
 * evidence-ladder bonus for "spoken" comes from the mic used DURING the
 * attempt (see answer-picker.tsx), which labs.submit already recorded.
 */
export function SpeakingStep({
  sentences,
  targetLang,
  onContinue,
  onBack,
}: {
  sentences: SpeakingSentence[];
  targetLang: SpeechLang;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const { speak } = useSpeech();
  const [spoken, setSpoken] = useState<Set<string>>(new Set());
  const [micKeys, setMicKeys] = useState<Record<string, number>>({});

  function markSpoken(key: string) {
    setSpoken((prev) => new Set(prev).add(key));
    setMicKeys((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  }

  function skipAll() {
    // The app speaks every sentence in turn, back to back — no penalty for not speaking (docs/lab-design.md section 4).
    const queue = [...sentences];
    const next = () => {
      const item = queue.shift();
      if (!item) return;
      speak(item.text, targetLang, false, next);
    };
    next();
  }

  return (
    <Screen>
      <div className="relative">
        <BackButton onClick={onBack} />
        <BrandHeader tagline={false} />
      </div>
      <h2 className="mt-4 text-[22px] font-bold">{t("lab.speaking.title")}</h2>
      <p className="mt-2 text-base text-muted">{t("lab.speaking.subtitle")}</p>

      <ul className="mt-4 flex flex-col gap-3">
        {sentences.map((s) => {
          const done = spoken.has(s.key);
          return (
            <li key={s.key} className={cx("rounded-2xl border p-4", done ? "border-accent/50 bg-accent/10" : "border-line bg-surface")}>
              <p className="text-[18px] leading-snug break-words">{s.text}</p>
              <p className="mt-1 text-base break-words text-muted">{s.meaning}</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {done ? (
                  <p className="text-base font-semibold text-accent">{t("lab.speaking.spoken")}</p>
                ) : (
                  <LiveMic
                    key={micKeys[s.key] ?? 0}
                    purpose="target"
                    variant="compact"
                    stopOn="first-turn"
                    settleMs={300}
                    compactLabel={t("lab.speaking.speak")}
                    onFinal={() => markSpoken(s.key)}
                  />
                )}
                <button
                  type="button"
                  onClick={() => speak(s.text, targetLang, false)}
                  className="text-base text-muted underline underline-offset-2"
                >
                  {t("lab.speaking.listenInstead")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto flex flex-col gap-3 pt-6 pb-4">
        <button type="button" onClick={skipAll} className="h-12 text-base font-semibold text-accent">
          {t("lab.speaking.skipAll")}
        </button>
        <PrimaryButton type="button" onClick={onContinue}>
          {t("lab.speaking.continue")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}
