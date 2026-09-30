"use client";

import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useI18n } from "@/i18n/provider";
import { PrimaryButton } from "@/components/ui";
import { PartnerScreen } from "./partner-screen";

function Svg({ size = 22, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
const MicIcon = () => (
  <Svg>
    <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
  </Svg>
);
const CalendarIcon = () => (
  <Svg>
    <rect x="3.5" y="5" width="17" height="16" rx="2" />
    <path d="M8 3v4M16 3v4M3.5 10h17" />
  </Svg>
);
const PeopleIcon = () => (
  <Svg>
    <circle cx="9" cy="8" r="3" />
    <path d="M2.5 20v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1" />
    <circle cx="18" cy="9" r="2.3" />
    <path d="M21.5 20v-.8a4 4 0 0 0-3-3.87" />
  </Svg>
);
const DollarIcon = () => (
  <Svg size={20}>
    <path d="M12 2v20M17 6.5c0-1.9-2.2-3.5-5-3.5s-5 1.6-5 3.5S9.2 10 12 10s5 1.6 5 3.5-2.2 3.5-5 3.5-5-1.6-5-3.5" />
  </Svg>
);

/** Screen 1: apply as a partner, then straight into the speaking test. */
export function BecomePartner({ onBack, onStarted }: { onBack: () => void; onStarted: () => void }) {
  const { t } = useI18n();
  const me = useQuery(api.users.me, {});
  const applyAsPartner = useMutation(api.partners.applyAsPartner);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eligible = me === undefined ? null : (me?.knownLanguages ?? []).includes("en");

  async function onStart() {
    setBusy(true);
    setError(null);
    try {
      await applyAsPartner({ targetLanguage: "en" });
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("partner.become.error"));
      setBusy(false);
    }
  }

  const steps: Array<{ icon: ReactNode; title: string; body: string }> = [
    { icon: <MicIcon />, title: t("partner.become.step1.title"), body: t("partner.become.step1.body") },
    { icon: <CalendarIcon />, title: t("partner.become.step2.title"), body: t("partner.become.step2.body") },
    { icon: <PeopleIcon />, title: t("partner.become.step3.title"), body: t("partner.become.step3.body") },
  ];

  return (
    <PartnerScreen onBack={onBack}>
      <section className="mt-6">
        <h2 className="text-[26px] leading-tight font-bold">{t("partner.become.title")}</h2>

        <ol className="mt-6 divide-y divide-line rounded-2xl border border-line bg-surface">
          {steps.map((s, i) => (
            <li key={s.title} className="flex items-center gap-4 px-4 py-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-base font-semibold text-accent">
                {i + 1}
              </span>
              <span className="text-muted">{s.icon}</span>
              <div>
                <p className="text-base font-semibold">{s.title}</p>
                <p className="text-base text-muted">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-4 flex flex-col gap-3">
          <div className="flex items-start gap-3 rounded-2xl border border-accent/40 bg-accent/10 p-4">
            <span className="text-accent"><DollarIcon /></span>
            <p className="text-base font-semibold">{t("partner.become.earn")}</p>
          </div>
          <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-4">
            <span className="text-muted"><PeopleIcon /></span>
            <p className="text-base text-muted">{t("partner.become.flexible")}</p>
          </div>
          <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-4">
            <span className="text-accent">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" />
                <path d="M9 12.5l2 2 4-4.5" />
              </svg>
            </span>
            <p className="text-base text-muted">{t("partner.become.noDegree")}</p>
          </div>
        </div>
      </section>

      <div className="mt-auto flex flex-col gap-3 pt-8">
        {error ? (
          <p role="alert" className="text-center text-base text-danger">
            {error}
          </p>
        ) : null}
        {eligible === false ? (
          <p role="alert" className="text-center text-base text-danger">
            {t("partner.become.needsEnglish")}
          </p>
        ) : (
          <PrimaryButton type="button" busy={busy} disabled={eligible === null} onClick={() => void onStart()}>
            {t("partner.become.start")}
          </PrimaryButton>
        )}
      </div>
    </PartnerScreen>
  );
}
