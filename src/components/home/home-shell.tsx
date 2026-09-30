"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { cx } from "@/components/ui";

export type Tab = "pron" | "words" | "units";
export const TABS: readonly Tab[] = ["pron", "words", "units"];

export function passLabel(daysLeft: number, t: (key: MessageKey, vars?: Record<string, string | number>) => string): string {
  if (daysLeft <= 0) return t("home.passToday");
  if (daysLeft === 1) return t("home.passDay");
  return t("home.passDays", { n: daysLeft });
}

export function HomeHeader({ name, daysLeft }: { name: string | null; daysLeft: number | null }) {
  const { t } = useI18n();
  return (
    <header>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[26px] leading-tight font-bold tracking-tight">
            <span className="text-accent">Speak</span>
            <span>Up</span>
          </h1>
          <p className="text-[13px] leading-tight text-muted">{t("brand.by")}</p>
        </div>
        {daysLeft !== null ? (
          <span className="rounded-full border border-accent/60 bg-accent/10 px-3 py-1.5 text-[14px] font-semibold text-accent">
            {passLabel(daysLeft, t)}
          </span>
        ) : null}
      </div>
      {name ? <p className="mt-4 text-[22px] font-bold">{t("home.greeting", { name })}</p> : null}
    </header>
  );
}

/** The three sections. Arrow keys move between them, as tabs should. */
export function TabBar({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  const { t } = useI18n();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = TABS.indexOf(tab);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : null;
    if (next === null) return;
    const target = TABS[(next + TABS.length) % TABS.length]!;
    onChange(target);
    refs.current[TABS.indexOf(target)]?.focus();
    e.preventDefault();
  }

  return (
    <div
      role="tablist"
      aria-label={t("home.tabsLabel")}
      onKeyDown={onKeyDown}
      className="mt-4 grid grid-cols-3 gap-1 rounded-2xl border border-line bg-surface p-1"
    >
      {TABS.map((id, i) => (
        <button
          key={id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${id}`}
          aria-selected={tab === id}
          aria-controls={`panel-${id}`}
          tabIndex={tab === id ? 0 : -1}
          onClick={() => onChange(id)}
          className={cx(
            "min-h-12 rounded-xl px-1 text-base font-semibold select-none transition-colors",
            tab === id ? "bg-accent text-accent-ink" : "hover:bg-surface-2",
          )}
        >
          {t(`home.tab.${id}` as MessageKey)}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ tab, children }: { tab: Tab; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className="outline-none">
      {children}
    </div>
  );
}

function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const ROOMS_ICON = (
  <path d="M17 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8M21 20v-2a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8" />
);

/** Home and Rooms work today; Practice is still shown as coming soon. */
export function BottomNav() {
  const { t } = useI18n();
  return (
    <nav
      aria-label={t("home.nav.label")}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/95 backdrop-blur"
    >
      <ul className="mx-auto grid w-full max-w-[440px] grid-cols-3 px-5 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
        <li className="flex flex-col items-center gap-0.5 py-1 text-accent" aria-current="page">
          <NavIcon>
            <path d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" />
          </NavIcon>
          <span className="text-[14px] font-semibold">{t("home.nav.home")}</span>
        </li>
        <li aria-disabled="true" className="flex flex-col items-center gap-0.5 py-1 text-muted opacity-70">
          <NavIcon>
            <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
          </NavIcon>
          <span className="text-[14px]">{t("home.nav.practice")}</span>
          <span className="text-[12px] leading-none">{t("auth.comingSoon")}</span>
        </li>
        <li className="flex flex-col items-center gap-0.5 py-1 text-muted">
          <Link href="/rooms" className="flex flex-col items-center gap-0.5 hover:text-fg">
            <NavIcon>{ROOMS_ICON}</NavIcon>
            <span className="text-[14px]">{t("home.nav.rooms")}</span>
          </Link>
        </li>
      </ul>
    </nav>
  );
}
