"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n/provider";
import { PrimaryButton, cx } from "@/components/ui";

const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
/** A Sunday-anchored reference week (2024-01-07 was a Sunday), so `Intl` gives a correctly localized short weekday name per dayOfWeek. */
const REFERENCE_SUNDAY = new Date(2024, 0, 7);
function dayShortLabel(dayOfWeek: number, lang: string): string {
  const d = new Date(REFERENCE_SUNDAY);
  d.setDate(d.getDate() + dayOfWeek);
  return new Intl.DateTimeFormat(lang === "hi" ? "hi-IN" : "en-GB", { weekday: "short" }).format(d);
}
/** 2-hour blocks, 9am to 9pm. */
const BLOCKS: Array<{ start: number; end: number }> = Array.from({ length: 6 }, (_, i) => ({
  start: (9 + i * 2) * 60,
  end: (9 + (i + 1) * 2) * 60,
}));

function blockLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${period}`;
}

type Slot = { dayOfWeek: number; startMinute: number; endMinute: number; timezone: string };
/** `day -> set of block indices that are on`. */
type Grid = Record<number, Set<number>>;

function emptyGrid(): Grid {
  return Object.fromEntries(DAYS.map((d) => [d, new Set<number>()])) as Grid;
}

function gridFromSlots(slots: readonly Slot[]): Grid {
  const g = emptyGrid();
  for (const s of slots) {
    const i = BLOCKS.findIndex((b) => b.start === s.startMinute && b.end === s.endMinute);
    if (i !== -1) g[s.dayOfWeek]?.add(i);
  }
  return g;
}

const commonTimezones = [
  "UTC",
  "Asia/Kolkata",
  "Asia/Karachi",
  "Asia/Dhaka",
  "Asia/Kathmandu",
  "Europe/Berlin",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
];

export function AvailabilityGrid({
  initialSlots,
  onSave,
  saving,
  saved,
}: {
  initialSlots: readonly Slot[];
  onSave: (slots: Slot[]) => void;
  saving: boolean;
  saved: boolean;
}) {
  const { t, lang } = useI18n();
  const [day, setDay] = useState<number>(new Date().getDay());
  const [grid, setGrid] = useState<Grid>(() => gridFromSlots(initialSlots));
  const [timezone, setTimezone] = useState<string>(() => initialSlots[0]?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);

  // If the loaded availability arrives after first paint, adopt it once.
  useEffect(() => {
    if (initialSlots.length > 0) {
      setGrid(gridFromSlots(initialSlots));
      setTimezone(initialSlots[0]!.timezone);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSlots.length]);

  const tzOptions = useMemo(() => {
    const supported: string[] =
      typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : commonTimezones;
    return supported.includes(timezone) ? supported : [timezone, ...supported];
  }, [timezone]);

  function toggleBlock(blockIndex: number) {
    setGrid((prev) => {
      const next: Grid = { ...prev, [day]: new Set(prev[day]) };
      if (next[day]!.has(blockIndex)) next[day]!.delete(blockIndex);
      else next[day]!.add(blockIndex);
      return next;
    });
  }

  function save() {
    const slots: Slot[] = [];
    for (const d of DAYS) {
      for (const i of grid[d] ?? []) {
        const b = BLOCKS[i]!;
        slots.push({ dayOfWeek: d, startMinute: b.start, endMinute: b.end, timezone });
      }
    }
    onSave(slots);
  }

  return (
    <div>
      <h3 className="text-base font-semibold">{t("partner.setup.availabilityTitle")}</h3>
      <p className="mt-1 text-base text-muted">{t("partner.setup.availabilitySubtitle")}</p>

      <div role="tablist" aria-label={t("partner.setup.availabilityTitle")} className="mt-4 flex gap-1 overflow-x-auto pb-1">
        {DAYS.map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={day === d}
            onClick={() => setDay(d)}
            className={cx(
              "min-h-11 shrink-0 rounded-xl px-4 text-base font-semibold",
              day === d ? "bg-accent text-accent-ink" : "border border-line bg-surface text-muted hover:border-line-strong",
            )}
          >
            {dayShortLabel(d, lang)}
          </button>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        {BLOCKS.map((b, i) => {
          const on = grid[day]?.has(i) ?? false;
          return (
            <button
              key={i}
              type="button"
              aria-pressed={on}
              onClick={() => toggleBlock(i)}
              className={cx(
                "flex min-h-12 items-center justify-center rounded-xl border px-3 text-base font-semibold",
                on ? "border-accent bg-accent/15 text-fg" : "border-line bg-surface text-muted hover:border-line-strong",
              )}
            >
              {blockLabel(b.start)} – {blockLabel(b.end)}
            </button>
          );
        })}
      </div>

      <div className="mt-5">
        <label htmlFor="partner-tz" className="mb-2 block text-base font-medium">
          {t("partner.setup.timezone")}
        </label>
        <select
          id="partner-tz"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className="h-14 w-full rounded-2xl border border-line bg-surface px-4 text-base text-fg focus:border-accent focus:outline-none"
        >
          {tzOptions.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-5">
        {saved ? (
          <p role="status" className="mb-2 text-center text-base text-accent">
            {t("partner.setup.saved")}
          </p>
        ) : null}
        <PrimaryButton type="button" busy={saving} onClick={save}>
          {t("partner.setup.save")}
        </PrimaryButton>
      </div>
    </div>
  );
}
