"use client";

import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { SetupShell } from "@/components/setup-shell";
import { ChoicePill, PrimaryButton } from "@/components/ui";
import { LiveMic } from "@/components/live-mic/live-mic";

const MINUTES_OPTIONS = [5, 10, 15] as const;
export type WizardMinutes = (typeof MINUTES_OPTIONS)[number];

export function DescribeStep({
  scenario,
  minutes,
  level,
  onChangeScenario,
  onChangeMinutes,
  onBack,
  onContinue,
}: {
  scenario: string;
  minutes: WizardMinutes;
  level: string | null;
  onChangeScenario: (v: string) => void;
  onChangeMinutes: (v: WizardMinutes) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { t } = useI18n();

  return (
    <SetupShell
      title={t("room.book.describe.title")}
      subtitle={t("room.book.describe.subtitle")}
      onBack={onBack}
      footer={
        <PrimaryButton type="button" disabled={scenario.trim().length === 0} onClick={onContinue}>
          {t("common.continue")}
        </PrimaryButton>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <textarea
            value={scenario}
            onChange={(e) => onChangeScenario(e.target.value)}
            placeholder={t("room.book.describe.placeholder")}
            rows={4}
            maxLength={300}
            aria-label={t("room.book.describe.subtitle")}
            className="w-full rounded-2xl border border-line bg-surface p-4 text-base text-fg placeholder:text-placeholder focus:border-accent focus:outline-none"
          />
          <p className="mt-1 text-right text-[13px] text-muted">{scenario.length}/300</p>
          <div className="mt-2">
            <LiveMic
              purpose="own"
              variant="compact"
              onFinal={(result) => onChangeScenario(result.transcript)}
            />
          </div>
        </div>

        {level !== null ? (
          <p className="text-base text-muted">
            {t("room.book.describe.levelLabel")}: <span className="font-semibold text-fg">{t(`level.${level}` as MessageKey)}</span>
          </p>
        ) : null}

        <div>
          <h3 className="text-base font-semibold">{t("room.book.describe.minutesTitle")}</h3>
          <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label={t("room.book.describe.minutesTitle")}>
            {MINUTES_OPTIONS.map((m) => (
              <ChoicePill key={m} name="minutes" value={String(m)} checked={minutes === m} onChange={() => onChangeMinutes(m)}>
                {t("room.live.minSession", { n: m })}
              </ChoicePill>
            ))}
          </div>
        </div>
      </div>
    </SetupShell>
  );
}
