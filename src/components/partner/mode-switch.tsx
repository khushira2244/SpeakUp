"use client";

import Link from "next/link";
import { useI18n } from "@/i18n/provider";

/** Small pill linking to the other mode. Placed near the header on Home and every partner screen. */
export function ModeSwitch({ mode }: { mode: "learner" | "partner" }) {
  const { t } = useI18n();
  const toPartner = mode === "learner";
  return (
    <Link
      href={toPartner ? "/partner" : "/home"}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line-strong px-3 text-[14px] font-semibold text-fg hover:border-accent"
    >
      <SwitchIcon />
      {t(toPartner ? "partner.modeSwitch.toPartner" : "partner.modeSwitch.toLearner")}
    </Link>
  );
}

function SwitchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 7h11l-3-3M17 17H6l3 3" />
    </svg>
  );
}
