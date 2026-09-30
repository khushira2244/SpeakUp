"use client";

import { useI18n } from "@/i18n/provider";
import { BrandHeader, PrimaryButton, Screen, Spinner } from "@/components/ui";

function TrophyIcon() {
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" />
      <path d="M8 5H5a3 3 0 0 0 3 5M16 5h3a3 3 0 0 1-3 5" />
      <path d="M12 13v3M9 20h6M10 17h4v3h-4z" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 1 3 6.7" />
      <path d="M3 18v-5h5" />
    </svg>
  );
}

export function ResultStep({
  pass,
  correctCount,
  totalCount,
  retriesLeft,
  retrying,
  onRetry,
  onBack,
}: {
  pass: boolean;
  /** null when returning to an already-graded lab from an earlier session — the per-attempt score isn't stored, so it isn't shown rather than faked. */
  correctCount: number | null;
  totalCount: number;
  retriesLeft: number;
  retrying: boolean;
  onRetry: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const canRetry = !pass && retriesLeft > 0;

  return (
    <Screen>
      <BrandHeader tagline={false} />
      <div className="mt-10 flex flex-1 flex-col items-center text-center">
        <span className={pass ? "text-accent" : "text-muted"}>{pass ? <TrophyIcon /> : <RetryIcon />}</span>
        <h1 className="mt-4 text-[26px] font-bold">{t(pass ? "lab.result.passTitle" : "lab.result.notYetTitle")}</h1>
        <p className="mt-2 text-lg text-muted">{t(pass ? "lab.result.passBody" : "lab.result.notYetBody")}</p>
        {correctCount !== null ? (
          <p className="mt-4 rounded-full border border-line-strong px-4 py-1.5 text-base font-semibold">
            {t("lab.result.score", { correct: correctCount, total: totalCount })}
          </p>
        ) : null}

        {!pass && retriesLeft === 0 ? (
          <div className="mt-6 w-full rounded-2xl border border-line bg-surface p-4">
            <p className="text-base font-semibold">{t("lab.result.noRetriesTitle")}</p>
            <p className="mt-1 text-base text-muted">{t("lab.result.noRetriesBody")}</p>
          </div>
        ) : null}
      </div>

      <div className="mt-auto flex flex-col gap-3 pt-6">
        {canRetry ? (
          <PrimaryButton type="button" busy={retrying} onClick={onRetry}>
            {retrying ? (
              <span className="flex items-center gap-2">
                <Spinner />
                {t("lab.result.retrying")}
              </span>
            ) : (
              t("lab.result.retry", { n: retriesLeft })
            )}
          </PrimaryButton>
        ) : null}
        <button
          type="button"
          onClick={onBack}
          className="h-12 text-base font-semibold text-accent"
        >
          {t("lab.result.backToUnits")}
        </button>
      </div>
    </Screen>
  );
}
