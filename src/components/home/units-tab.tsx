"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FunctionReturnType } from "convex/server";
import { useAction, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { GoalIcon } from "@/components/icons";
import { PrimaryButton, Spinner, cx } from "@/components/ui";
import { Sheet, SpeakButton } from "./sheet";

/** The lab is built for these levels only (docs/lab-design.md) — intermediate/confident stay design-only. */
const LAB_LEVELS = new Set(["starting", "basic"]);

type UnitsData = NonNullable<FunctionReturnType<typeof api.home.units>>;
type Plan = NonNullable<UnitsData["plan"]>;
type Day = Plan["days"][number];

function CheckDot({ done, today, n }: { done: boolean; today: boolean; n: number }) {
  if (done) {
    return (
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-ink" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cx(
        "grid size-9 shrink-0 place-items-center rounded-full text-base font-semibold",
        today ? "border-[3px] border-accent text-accent" : "border border-line-strong text-muted",
      )}
    >
      {n}
    </span>
  );
}

/** Shown wherever the plan section would go while `plan` is still null: a spinner while generating, or a "Try again" button once the last attempt failed. */
function PlanPending({
  status,
  retrying,
  onRetry,
}: {
  status: "generating" | "failed" | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  if (status === "failed") {
    return (
      <div className="mt-3 flex flex-col items-center gap-2 text-center" role="alert">
        <p className="text-base font-semibold text-danger">{t("units.failedTitle")}</p>
        <p className="text-base text-muted">{t("units.failedBody")}</p>
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-1 inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-5 text-base font-semibold text-accent-ink disabled:opacity-60"
        >
          {retrying ? <Spinner /> : null}
          {retrying ? t("units.retrying") : t("units.retry")}
        </button>
      </div>
    );
  }
  return (
    <p className="mt-3 flex items-center gap-2 text-base text-muted" role="status">
      <Spinner />
      {t("units.preparing")}
    </p>
  );
}

export function UnitsTab() {
  const { t } = useI18n();
  const router = useRouter();
  const data = useQuery(api.home.units, {});
  // The units data has no language of its own; the Words data does (and is already loaded by the other tabs).
  const lang = useQuery(api.home.words, {})?.targetLanguage ?? "en";
  // The lab is level-gated — progressCounts already carries the learner's current level.
  const level = useQuery(api.home.progressCounts, {})?.level ?? null;
  const generatePlan = useAction(api.plans.generatePlan);
  const [inside, setInside] = useState(false);
  const [section, setSection] = useState<"concepts" | "plan">("concepts");
  const [day, setDay] = useState<Day | null>(null);
  const [retrying, setRetrying] = useState(false);

  if (data === undefined) {
    return (
      <div className="mt-10 flex flex-col items-center gap-3 text-muted" role="status">
        <Spinner />
        <p className="text-base">{t("common.loading")}</p>
      </div>
    );
  }
  if (data === null) return <p className="mt-8 text-center text-base text-muted">{t("words.empty")}</p>;

  const label =
    data.goal.goalType === "custom" ? data.goal.goalText : t(`goal.type.${data.goal.goalType}` as MessageKey);
  const title = t("units.unit", { n: 1, title: label });
  const plan = data.plan;
  const total = plan?.days.length ?? 0;
  const goalId = data.goal.goalId;

  async function retryPlan() {
    setRetrying(true);
    try {
      await generatePlan({ goalId });
    } catch {
      // The action itself already recorded "failed" plan status; the query
      // re-renders from that, so no local error state is needed here.
    } finally {
      setRetrying(false);
    }
  }

  // ---- inside a unit ---------------------------------------------------------
  if (inside) {
    return (
      <div className="mt-4">
        <button type="button" onClick={() => setInside(false)} className="inline-flex min-h-11 items-center gap-2 text-base text-muted hover:text-fg">
          <span aria-hidden="true">←</span>
          {t("units.back")}
        </button>
        <h3 className="mt-1 text-[24px] leading-tight font-bold break-words">{title}</h3>

        <div role="group" aria-label={title} className="mt-4 grid grid-cols-2 gap-1 rounded-2xl border border-line bg-surface p-1">
          {(["concepts", "plan"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={section === s}
              onClick={() => setSection(s)}
              className={cx("h-11 rounded-xl text-base font-semibold select-none", section === s ? "bg-accent text-accent-ink" : "hover:bg-surface-2")}
            >
              {t(s === "concepts" ? "units.concepts" : "units.plan")}
            </button>
          ))}
        </div>

        {section === "concepts" ? (
          <ul className="mt-4 grid gap-3">
            {data.concepts.map((c) => (
              <li key={c.pattern} className="rounded-2xl border border-line bg-surface p-4">
                <p className="text-[18px] font-semibold break-words">{c.pattern}</p>
                <div className="mt-2 flex items-center gap-2">
                  <p className="min-w-0 flex-1 text-[18px] break-words">{c.example}</p>
                  <SpeakButton text={c.example} lang={lang} label={`${t("sheet.listen")}: ${c.example}`} />
                </div>
                <p className="mt-1 text-base break-words text-muted">{c.meaning}</p>
              </li>
            ))}
          </ul>
        ) : plan === null ? (
          <div className="mt-8">
            <PlanPending status={data.planStatus} retrying={retrying} onRetry={retryPlan} />
          </div>
        ) : (
          <>
            <ol className="mt-4 divide-y divide-line rounded-2xl border border-line bg-surface">
              {plan.days.map((d) => {
                const done = d.dayNo < plan.currentDay;
                const today = d.dayNo === plan.currentDay;
                return (
                  <li key={d.dayNo}>
                    <button
                      type="button"
                      onClick={() => setDay(d)}
                      className={cx("flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left", today && "bg-accent/10")}
                    >
                      <CheckDot done={done} today={today} n={d.dayNo} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-base leading-snug font-semibold break-words">{d.title}</span>
                        <span className="block text-base text-muted">{t("units.words", { n: d.words.length })}</span>
                      </span>
                      {today ? (
                        <span className="rounded-full bg-accent px-3 py-1 text-[14px] font-semibold text-accent-ink">{t("units.today")}</span>
                      ) : (
                        <span className="text-base text-muted">
                          {done ? t("units.status.done") : t("units.status.upcoming")}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>

            <section aria-labelledby="lab-title" className="mt-4 rounded-2xl border border-accent/50 bg-surface p-4">
              <h4 id="lab-title" className="text-[18px] font-semibold">
                {t("units.labTitle")}
              </h4>
              {level !== null && !LAB_LEVELS.has(level) ? <p className="mt-1 text-base text-muted">{t("lab.levelNotSupported")}</p> : null}
              <button
                type="button"
                disabled={level === null || !LAB_LEVELS.has(level)}
                onClick={() => router.push(`/lab/${goalId}/${plan.currentDay}`)}
                className="mt-3 h-12 w-full rounded-2xl bg-accent text-[17px] font-semibold text-accent-ink disabled:bg-surface-2 disabled:text-muted"
              >
                {t("units.startLab")}
              </button>
            </section>
          </>
        )}

        {day ? (
          <Sheet title={day.title} onClose={() => setDay(null)}>
            {day.patterns.length > 0 ? (
              <div className="mt-3">
                <p className="text-base text-muted">{t("units.dayPattern")}</p>
                {day.patterns.map((p) => (
                  <p key={p} className="text-[20px] font-semibold break-words">
                    {p}
                  </p>
                ))}
              </div>
            ) : null}
            <p className="mt-5 text-base text-muted">{t("units.dayWords")}</p>
            <ul className="mt-2 divide-y divide-line rounded-2xl border border-line bg-bg">
              {day.words.map((w) => (
                <li key={w.word} className="flex items-center">
                  <div className="min-w-0 flex-1 px-4 py-3">
                    <p className="text-[18px] font-semibold break-words">{w.word}</p>
                    {w.pronunciationHint ? <p className="text-base text-muted">{w.pronunciationHint}</p> : null}
                    <p className="text-base break-words text-muted">{w.meaning}</p>
                  </div>
                  <SpeakButton text={w.word} lang={lang} label={`${t("sheet.listen")}: ${w.word}`} />
                </li>
              ))}
            </ul>
            <div className="mt-5">
              <PrimaryButton type="button" onClick={() => setDay(null)}>
                {t("sheet.close")}
              </PrimaryButton>
            </div>
          </Sheet>
        ) : null}
      </div>
    );
  }

  // ---- list of units ----------------------------------------------------------
  const progress = plan ? Math.min(100, ((plan.currentDay - 1) / Math.max(1, total)) * 100) : 0;
  return (
    <div className="mt-4 grid gap-3">
      <section className="rounded-3xl border border-accent bg-surface p-4 shadow-[0_0_0_1px_var(--color-accent)]">
        <div className="flex items-center gap-3">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-surface-2 text-accent">
            <GoalIcon type={data.goal.goalType} size={26} />
          </span>
          <h3 className="min-w-0 flex-1 text-[19px] leading-snug font-bold break-words">{title}</h3>
        </div>
        {plan ? (
          <>
            <p className="mt-3 text-base text-muted">{t("units.day", { n: plan.currentDay, total })}</p>
            <div role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={plan.currentDay - 1} className="mt-2 h-2 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
            </div>
          </>
        ) : (
          <PlanPending status={data.planStatus} retrying={retrying} onRetry={retryPlan} />
        )}
        <div className="mt-4">
          <PrimaryButton type="button" onClick={() => setInside(true)} disabled={plan === null}>
            {t("common.continue")}
          </PrimaryButton>
        </div>
      </section>

      <section className="rounded-3xl border border-line bg-surface p-4 text-muted">
        <div className="flex items-center gap-3">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-surface-2">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
              <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
            </svg>
          </span>
          <div>
            <h3 className="text-[19px] leading-snug font-bold">{t("units.unitN", { n: 2 })}</h3>
            <p className="text-base">{t("units.locked", { n: 1 })}</p>
          </div>
        </div>
      </section>
    </div>
  );
}
