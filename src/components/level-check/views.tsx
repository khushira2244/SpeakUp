"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { BackButton, BrandHeader, PrimaryButton, Screen, cx } from "@/components/ui";
import { GoalIcon } from "@/components/icons";
import type { GoalType } from "@/lib/setup-draft";
import type { LevelResult } from "./helpers";

// ---------------------------------------------------------------------------
// Small icons
// ---------------------------------------------------------------------------

function Svg({ size = 24, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
const DocIcon = () => (
  <Svg>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M9 12h6M9 16h6M9 8h3" />
  </Svg>
);
const ChatIcon = () => (
  <Svg>
    <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />
  </Svg>
);
const ClockIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);
const MicSvg = ({ size = 24 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
  </Svg>
);
const CheckSvg = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
const BarsIcon = () => (
  <Svg size={20}>
    <path d="M5 20v-5M12 20V9M19 20V4" />
  </Svg>
);

// ---------------------------------------------------------------------------
// 1. Intro
// ---------------------------------------------------------------------------

export function IntroView({
  onStart,
  busy,
  failed,
  onBack,
}: {
  onStart: () => void;
  busy: boolean;
  failed: boolean;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const rows: Array<{ icon: ReactNode; title: MessageKey; body: MessageKey }> = [
    { icon: <DocIcon />, title: "lc.intro.r1.title", body: "lc.intro.r1.body" },
    { icon: <ChatIcon />, title: "lc.intro.r2.title", body: "lc.intro.r2.body" },
    { icon: <ClockIcon />, title: "lc.intro.r3.title", body: "lc.intro.r3.body" },
  ];
  return (
    <Screen>
      <div className="relative">
        <BackButton onClick={onBack} />
        <BrandHeader />
      </div>

      <section className="mt-8">
        <h2 className="text-[28px] leading-tight font-bold">{t("lc.intro.title")}</h2>
        <p className="mt-3 text-base text-muted">{t("lc.intro.body")}</p>

        <ul className="mt-6 divide-y divide-line rounded-2xl border border-line bg-surface">
          {rows.map((row) => (
            <li key={row.title} className="flex items-center gap-4 px-4 py-4">
              <span className="text-muted">{row.icon}</span>
              <div>
                <p className="text-base font-semibold">{t(row.title)}</p>
                <p className="text-base text-muted">{t(row.body)}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex items-start gap-4 rounded-2xl border border-line bg-surface p-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
            <MicSvg />
          </span>
          <div>
            <p className="text-base font-semibold">{t("lc.intro.mic.title")}</p>
            <p className="text-base text-muted">{t("lc.intro.mic.body")}</p>
          </div>
        </div>
      </section>

      <div className="mt-auto flex flex-col gap-3 pt-8">
        {failed ? (
          <p role="alert" className="text-center text-base text-danger">
            {t("lc.intro.failed")}
          </p>
        ) : null}
        <PrimaryButton type="button" busy={busy} onClick={onStart}>
          {t("lc.intro.start")}
        </PrimaryButton>
        <p className="text-center text-base text-muted">{t("lc.intro.ownLang")}</p>
      </div>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// 4. Mic blocked
// ---------------------------------------------------------------------------

export function MicBlockedView({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  const steps: Array<{ title: MessageKey; body: MessageKey }> = [
    { title: "lc.blocked.s1.title", body: "lc.blocked.s1.body" },
    { title: "lc.blocked.s2.title", body: "lc.blocked.s2.body" },
    { title: "lc.blocked.s3.title", body: "lc.blocked.s3.body" },
  ];
  return (
    <Screen>
      <BrandHeader />

      <div className="mt-8 flex flex-col items-center text-center">
        <div className="relative grid size-28 place-items-center rounded-full border border-line bg-surface text-fg">
          <MicSvg size={52} />
          <span aria-hidden="true" className="absolute h-1 w-20 -rotate-45 rounded-full bg-danger" />
        </div>
        <h2 className="mt-6 text-[28px] leading-tight font-bold">{t("lc.blocked.title")}</h2>
        <p className="mt-3 text-base text-muted">{t("lc.blocked.body")}</p>
      </div>

      <section className="mt-6 rounded-2xl border border-line bg-surface p-4">
        <h3 className="text-base font-semibold">{t("lc.blocked.stepsTitle")}</h3>
        <ol className="mt-4 grid gap-4">
          {steps.map((step, i) => (
            <li key={step.title} className="flex items-start gap-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-base font-semibold">
                {i + 1}
              </span>
              <div>
                <p className="text-base font-semibold">{t(step.title)}</p>
                <p className="text-base text-muted">{t(step.body)}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-4 border-t border-line pt-4 text-base text-muted">{t("lc.blocked.ios")}</p>
      </section>

      <div className="mt-auto pt-8">
        <PrimaryButton type="button" onClick={onRetry}>
          {t("mic.tryAgain")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// 5. Processing
// ---------------------------------------------------------------------------

type StepState = "done" | "active" | "pending";

/**
 * The backend only reports "processing" / "done" / "failed", not which stage it
 * is in, so the three steps advance with time while it works and all complete
 * the moment the result is ready.
 */
export function ProcessingView({
  status,
  onComplete,
}: {
  status: "started" | "processing" | "done" | "failed";
  onComplete: () => void;
}) {
  const { t } = useI18n();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 0.5), 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (status !== "done") return;
    const id = setTimeout(onComplete, 900);
    return () => clearTimeout(id);
  }, [status, onComplete]);

  const activeIndex = status === "done" ? 3 : elapsed < 2 ? 0 : elapsed < 7 ? 1 : 2;
  const steps: Array<{ title: MessageKey; sub: MessageKey }> = [
    { title: "lc.proc.words", sub: "lc.proc.wordsSub" },
    { title: "lc.proc.speaking", sub: "lc.proc.speakingSub" },
    { title: "lc.proc.goal", sub: "lc.proc.goalSub" },
  ];

  return (
    <Screen>
      <BrandHeader />

      <section className="mt-8">
        <h2 className="text-[28px] leading-tight font-bold">{t("lc.proc.title")}</h2>
        <p className="mt-3 text-base text-muted">{t("lc.proc.body")}</p>

        <ol className="mt-8" aria-live="polite">
          {steps.map((step, i) => {
            const state: StepState = i < activeIndex ? "done" : i === activeIndex ? "active" : "pending";
            return (
              <li key={step.title} className="relative flex gap-4 pb-8 last:pb-0">
                {i < steps.length - 1 ? (
                  <span aria-hidden="true" className={cx("absolute top-9 left-[17px] h-[calc(100%-2.25rem)] w-0.5", state === "done" ? "bg-accent" : "bg-line-strong")} />
                ) : null}
                <span
                  className={cx(
                    "grid size-9 shrink-0 place-items-center rounded-full",
                    state === "done" && "bg-accent text-accent-ink",
                    state === "active" && "border-[3px] border-accent bg-bg",
                    state === "pending" && "border-2 border-line-strong bg-bg",
                  )}
                >
                  {state === "done" ? <CheckSvg size={16} /> : null}
                  {state === "active" ? <span className="size-2.5 animate-pulse rounded-full bg-accent" /> : null}
                </span>
                <div className={state === "pending" ? "text-muted" : ""}>
                  <p className="text-base font-semibold">{t(step.title)}</p>
                  <p className="text-base text-muted">{t(step.sub)}</p>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-8 flex items-start gap-3 rounded-2xl border border-line bg-surface p-4 text-muted">
          <ClockIcon />
          <p className="text-base">{elapsed >= 90 ? t("lc.proc.slow") : t("lc.proc.note")}</p>
        </div>
      </section>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Failed
// ---------------------------------------------------------------------------

export function FailedView({
  onRetry,
  onStartOver,
  busy,
}: {
  onRetry: () => void;
  onStartOver: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  return (
    <Screen>
      <BrandHeader />
      <div className="mt-16 flex flex-1 flex-col items-center text-center">
        <div className="grid size-28 place-items-center rounded-full bg-danger/15 text-danger">
          <Svg size={52}>
            <path d="M12 3 2.5 20h19z" />
            <path d="M12 10v5M12 18h.01" />
          </Svg>
        </div>
        <div role="alert">
          <h2 className="mt-8 text-[28px] leading-tight font-bold">{t("lc.failed.title")}</h2>
          <p className="mt-3 text-base text-muted">{t("lc.failed.body")}</p>
        </div>
      </div>
      <div className="flex flex-col gap-3 pt-6">
        <PrimaryButton type="button" busy={busy} onClick={onRetry}>
          {t("lc.failed.retry")}
        </PrimaryButton>
        <button type="button" disabled={busy} onClick={onStartOver} className="h-11 text-base text-muted hover:text-fg disabled:opacity-60">
          {t("lc.failed.startOver")}
        </button>
      </div>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// 6. Result
// ---------------------------------------------------------------------------

const DOT = { canUse: "bg-[#3ddc97]", practising: "bg-[#ffc247]", notYet: "bg-[#8a99a2]" } as const;
const BAR = { canUse: "bg-accent", practising: "bg-[#ffc247]", notYet: "bg-[#8a99a2]" } as const;

export function ResultView({
  goalType,
  goalLabel,
  result,
  meanings,
  showDemoNote,
  onContinue,
}: {
  goalType: GoalType;
  goalLabel: string;
  result: LevelResult;
  meanings: Record<string, { meaning: string; hint: string | null }>;
  showDemoNote: boolean;
  onContinue: () => void;
}) {
  const { t } = useI18n();
  const low = result.level === "starting";
  const total = Math.max(1, result.totalCount);
  const counts = [
    { key: "canUse", label: t("lc.result.canUse"), n: result.canUse.length },
    { key: "practising", label: t("lc.result.practising"), n: result.practising.length },
    { key: "notYet", label: t("lc.result.notYet"), n: result.notYet.length },
  ] as const;
  const firstWords = [...result.notYet, ...result.practising].slice(0, 5);
  const vars = { known: result.knownCount, total: result.totalCount };

  return (
    <Screen>
      <BrandHeader />

      <div className="mt-6 flex items-center gap-4 rounded-2xl border border-line bg-surface p-4">
        <span className="text-muted">
          <GoalIcon type={goalType} size={28} />
        </span>
        <div className="min-w-0">
          <p className="text-base text-muted">{t("lc.result.goal")}</p>
          <p className="text-base font-semibold break-words">{goalLabel}</p>
        </div>
      </div>

      <h2 className="mt-5 text-[26px] leading-tight font-bold">
        {low ? t("lc.result.headlineLow") : t("lc.result.headline", vars)}
      </h2>
      {low ? <p className="mt-2 text-base text-muted">{t("lc.result.subLow", vars)}</p> : null}

      <div className="mt-4 divide-y divide-line rounded-2xl border border-line bg-surface">
        {counts.map((c) => (
          <div key={c.key} className="flex items-center gap-3 px-4 py-3">
            <span aria-hidden="true" className={cx("size-4 shrink-0 rounded-full", DOT[c.key])} />
            <span className="w-[38%] shrink-0 text-base">{c.label}</span>
            <span aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
              <span className={cx("block h-full rounded-full", BAR[c.key])} style={{ width: `${(c.n / total) * 100}%` }} />
            </span>
            <span className="w-8 text-right text-base font-semibold">{c.n}</span>
          </div>
        ))}
      </div>

      {low && firstWords.length > 0 ? (
        <section aria-labelledby="first-words" className="mt-5 rounded-2xl border border-accent bg-surface p-4">
          <h3 id="first-words" className="text-base font-semibold">
            {t("lc.result.firstWords")}
          </h3>
          <ul className="mt-2 divide-y divide-line">
            {firstWords.map((w) => (
              <li key={w} className="flex items-baseline justify-between gap-4 py-2 text-base">
                <span>
                  {w}
                  {meanings[w]?.hint ? <span className="ml-2 text-muted">{meanings[w]?.hint}</span> : null}
                </span>
                <span className="text-right text-muted">{meanings[w]?.meaning ?? ""}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.grammar.length > 0 ? (
        <section aria-labelledby="grammar" className="mt-5">
          <h3 id="grammar" className="text-[20px] font-bold">
            {t("lc.result.grammar")}
          </h3>
          <ul className="mt-2 divide-y divide-line rounded-2xl border border-line bg-surface">
            {result.grammar.map((g) => (
              <li key={g.name} className="flex items-center gap-3 px-4 py-3 text-base">
                <GrammarIcon status={g.status} />
                <span className="break-words">{g.name}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="summary" className="mt-5">
        <h3 id="summary" className="text-[20px] font-bold">
          {t("lc.result.summary")}
        </h3>
        <p className="mt-2 rounded-2xl border border-line bg-surface p-4 text-base">{result.speakingSummary}</p>
      </section>

      <section aria-labelledby="level" className="mt-5">
        <h3 id="level" className="text-[20px] font-bold">
          {t("lc.result.level")}
        </h3>
        <p className="mt-2 inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface-2 px-4 py-2 text-base font-semibold">
          <span className="text-accent">
            <BarsIcon />
          </span>
          {t(`lc.level.${result.level}` as MessageKey)}
        </p>
      </section>

      <div className="mt-auto flex flex-col gap-3 pt-8">
        <PrimaryButton type="button" onClick={onContinue}>
          {t("lc.result.cta")}
        </PrimaryButton>
        {showDemoNote ? <p className="text-center text-base text-muted">{t("lc.result.demoNote")}</p> : null}
      </div>
    </Screen>
  );
}

function GrammarIcon({ status }: { status: "ok" | "practising" | "not_yet" }) {
  const { t } = useI18n();
  const label = t(status === "ok" ? "lc.result.canUse" : status === "practising" ? "lc.result.practising" : "lc.result.notYet");
  if (status === "ok") {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#3ddc97] text-accent-ink" role="img" aria-label={label}>
        <CheckSvg size={14} />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={label}
      className={cx("size-6 shrink-0 rounded-full border-[3px]", status === "practising" ? "border-[#ffc247]" : "border-[#8a99a2]")}
    />
  );
}
