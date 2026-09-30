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

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

function minutesToTimeInput(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeInputToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

type Slot = { dayOfWeek: number; startMinute: number; endMinute: number; timezone: string };
type Range = { start: number; end: number };
/** `day -> the custom hour ranges on for that day`. */
type Grid = Record<number, Range[]>;

function emptyGrid(): Grid {
  return Object.fromEntries(DAYS.map((d) => [d, []])) as Grid;
}

function gridFromSlots(slots: readonly Slot[]): Grid {
  const g = emptyGrid();
  for (const s of slots) {
    g[s.dayOfWeek]?.push({ start: s.startMinute, end: s.endMinute });
  }
  for (const d of DAYS) g[d]?.sort((a, b) => a.start - b.start);
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
  const [newStart, setNewStart] = useState("09:00");
  const [newEnd, setNewEnd] = useState("11:00");
  const [rangeError, setRangeError] = useState<string | null>(null);

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

  function addRange() {
    const start = timeInputToMinutes(newStart);
    const end = timeInputToMinutes(newEnd);
    if (start === null || end === null || start >= end) {
      setRangeError(t("partner.setup.invalidRange"));
      return;
    }
    setRangeError(null);
    setGrid((prev) => ({
      ...prev,
      [day]: [...(prev[day] ?? []), { start, end }].sort((a, b) => a.start - b.start),
    }));
  }

  function removeRange(index: number) {
    setGrid((prev) => ({ ...prev, [day]: (prev[day] ?? []).filter((_, i) => i !== index) }));
  }

  function save() {
    const slots: Slot[] = [];
    for (const d of DAYS) {
      for (const r of grid[d] ?? []) {
        slots.push({ dayOfWeek: d, startMinute: r.start, endMinute: r.end, timezone });
      }
    }
    onSave(slots);
  }

  const dayRanges = grid[day] ?? [];

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
            {(grid[d]?.length ?? 0) > 0 ? (
              <span className={cx("ml-1.5 inline-block size-1.5 rounded-full align-middle", day === d ? "bg-accent-ink" : "bg-accent")} />
            ) : null}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {dayRanges.length === 0 ? (
          <p className="text-base text-muted">{t("partner.setup.noRanges")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {dayRanges.map((r, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-3 rounded-xl border border-accent bg-accent/10 px-3 py-2.5"
              >
                <span className="text-base font-semibold">
                  {formatTime(r.start)} – {formatTime(r.end)}
                </span>
                <button
                  type="button"
                  onClick={() => removeRange(i)}
                  aria-label={t("partner.setup.removeRange")}
                  className="grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex items-end gap-2">
          <div className="flex-1">
            <label htmlFor="range-start" className="mb-1 block text-[13px] text-muted">
              {t("partner.setup.startTime")}
            </label>
            <input
              id="range-start"
              type="time"
              value={newStart}
              onChange={(e) => {
                setNewStart(e.target.value);
                setRangeError(null);
              }}
              className="h-12 w-full rounded-xl border border-line bg-surface px-3 text-base text-fg focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex-1">
            <label htmlFor="range-end" className="mb-1 block text-[13px] text-muted">
              {t("partner.setup.endTime")}
            </label>
            <input
              id="range-end"
              type="time"
              value={newEnd}
              onChange={(e) => {
                setNewEnd(e.target.value);
                setRangeError(null);
              }}
              className="h-12 w-full rounded-xl border border-line bg-surface px-3 text-base text-fg focus:border-accent focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={addRange}
            className="h-12 shrink-0 rounded-xl border border-line-strong px-4 text-base font-semibold hover:border-accent"
          >
            {t("partner.setup.addRange")}
          </button>
        </div>
        {rangeError ? (
          <p role="alert" className="mt-2 text-base text-danger">
            {rangeError}
          </p>
        ) : null}
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
