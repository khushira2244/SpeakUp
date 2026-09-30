"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useI18n } from "@/i18n/provider";
import { SetupShell } from "@/components/setup-shell";
import { ChoiceRow, PrimaryButton, Spinner, cx } from "@/components/ui";
import type { WizardMinutes } from "./describe-step";

export type Slot = { partnerProfileId: Id<"partnerProfiles">; partnerId: Id<"users">; startAt: number; endAt: number };
type SlotWithTaken = Slot & { taken: boolean };

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function dayLabel(startAt: number, lang: string, todayLabel: string): string {
  const d = new Date(startAt);
  if (d.toDateString() === new Date().toDateString()) return todayLabel;
  return new Intl.DateTimeFormat(lang === "hi" ? "hi-IN" : "en-GB", { weekday: "short", day: "numeric", month: "short" }).format(d);
}

function timeLabel(startAt: number, lang: string): string {
  return new Intl.DateTimeFormat(lang === "hi" ? "hi-IN" : "en-GB", { hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(startAt));
}

type Period = "morning" | "afternoon" | "evening";
const PERIODS: readonly Period[] = ["morning", "afternoon", "evening"];

function periodOf(startAt: number): Period {
  const h = new Date(startAt).getHours();
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}

/** How many free slots to show per time-of-day period before "Show all available times". */
const COLLAPSED_PER_PERIOD = 4;

export function WhenStep({
  targetLanguage,
  minutes,
  level,
  onBack,
  onContinue,
  busy,
  error,
}: {
  targetLanguage: "en" | "de";
  minutes: WizardMinutes;
  level: "starting" | "basic" | "intermediate" | "confident";
  onBack: () => void;
  onContinue: (mode: "now" | "later", slot: Slot | null) => void;
  busy: boolean;
  error?: string | null;
}) {
  const { t, lang } = useI18n();
  const [mode, setMode] = useState<"now" | "later">("now");
  const [selected, setSelected] = useState<Slot | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());

  const pricing = useQuery(api.rooms.roomPricing, {});
  const slots = useQuery(api.rooms.slotAvailability, mode === "later" ? { targetLanguage, minutes, level } : "skip");

  const nowPrice = pricing?.find((p) => p.mode === "now" && p.minutes === minutes) ?? null;
  const laterPrice = pricing?.find((p) => p.mode === "later" && p.minutes === minutes) ?? null;

  const byDay = useMemo(() => {
    if (!slots) return [];
    const groups = new Map<string, SlotWithTaken[]>();
    for (const s of slots) {
      const key = new Date(s.startAt).toDateString();
      const list = groups.get(key) ?? [];
      list.push(s);
      groups.set(key, list);
    }
    return [...groups.entries()];
  }, [slots]);

  const canContinue = mode === "now" || selected !== null;

  return (
    <SetupShell
      title={t("room.book.when.title")}
      onBack={onBack}
      footer={
        <div className="flex flex-col gap-3">
          {error ? (
            <p role="alert" className="text-center text-base text-danger">
              {error}
            </p>
          ) : null}
          <PrimaryButton type="button" busy={busy} disabled={!canContinue || busy} onClick={() => onContinue(mode, selected)}>
            {t("common.continue")}
          </PrimaryButton>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <ChoiceRow name="mode" value="now" checked={mode === "now"} onChange={() => setMode("now")}>
          <span className="flex flex-col gap-0.5">
            <span className="font-semibold">{t("room.book.when.now")}</span>
            <span className="text-base text-muted">{t("room.book.when.nowHint")}</span>
            {nowPrice ? <span className="text-[15px] font-semibold text-accent">{usd(nowPrice.displayUsdCents)}</span> : null}
          </span>
        </ChoiceRow>
        <ChoiceRow name="mode" value="later" checked={mode === "later"} onChange={() => setMode("later")}>
          <span className="flex flex-col gap-0.5">
            <span className="font-semibold">{t("room.book.when.later")}</span>
            <span className="text-base text-muted">{t("room.book.when.laterHint")}</span>
            {laterPrice ? <span className="text-[15px] font-semibold text-accent">{usd(laterPrice.displayUsdCents)}</span> : null}
          </span>
        </ChoiceRow>

        {mode === "later" ? (
          <div className="mt-2">
            <h3 className="text-base font-semibold">{t("room.book.when.pickSlot")}</h3>
            {slots === undefined ? (
              <div className="mt-4 flex justify-center text-muted" role="status">
                <Spinner />
              </div>
            ) : byDay.length === 0 ? (
              <p className="mt-3 text-base text-muted">{t("room.book.when.noSlots")}</p>
            ) : (
              <div className="mt-3 flex flex-col gap-5">
                {byDay.map(([key, daySlots]) => {
                  const expanded = expandedDays.has(key);
                  const byPeriod = new Map<Period, SlotWithTaken[]>();
                  for (const s of daySlots) {
                    const p = periodOf(s.startAt);
                    const list = byPeriod.get(p) ?? [];
                    list.push(s);
                    byPeriod.set(p, list);
                  }
                  const hasMore = PERIODS.some((p) => (byPeriod.get(p) ?? []).filter((s) => !s.taken).length > COLLAPSED_PER_PERIOD);

                  return (
                    <div key={key}>
                      <p className="text-base font-semibold text-muted">{dayLabel(daySlots[0]!.startAt, lang, t("room.book.when.today"))}</p>
                      <div className="mt-2 flex flex-col gap-3">
                        {PERIODS.map((period) => {
                          const periodSlots = byPeriod.get(period) ?? [];
                          if (periodSlots.length === 0) return null;
                          const free = periodSlots.filter((s) => !s.taken);
                          const shown = expanded ? periodSlots : free.slice(0, COLLAPSED_PER_PERIOD);
                          if (shown.length === 0) return null;
                          return (
                            <div key={period}>
                              <p className="text-[13px] font-semibold tracking-wide text-muted uppercase">
                                {t(`room.book.when.${period}` as const)}
                              </p>
                              <div className="mt-1.5 flex flex-wrap gap-2">
                                {shown.map((s) => {
                                  const checked = selected !== null && selected.startAt === s.startAt && selected.partnerProfileId === s.partnerProfileId;
                                  return (
                                    <button
                                      key={`${s.partnerProfileId}-${s.startAt}`}
                                      type="button"
                                      disabled={s.taken}
                                      onClick={() => setSelected(s)}
                                      className={cx(
                                        "flex min-h-11 flex-col items-center justify-center rounded-2xl border px-4 py-1.5 text-base font-semibold transition-colors",
                                        s.taken
                                          ? "cursor-not-allowed border-line bg-surface-2 text-muted opacity-60"
                                          : checked
                                            ? "border-accent bg-accent/15 text-fg"
                                            : "border-line bg-surface text-muted hover:border-line-strong",
                                      )}
                                    >
                                      {timeLabel(s.startAt, lang)}
                                      {s.taken ? <span className="text-[12px] font-normal">{t("room.book.when.taken")}</span> : null}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {hasMore || expanded ? (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedDays((prev) => {
                              const next = new Set(prev);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                          className="mt-2 text-base font-semibold text-accent"
                        >
                          {expanded ? t("room.book.when.showFewer") : t("room.book.when.showAll")}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </SetupShell>
  );
}
