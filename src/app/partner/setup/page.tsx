"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, PrimaryButton, Screen, Spinner } from "@/components/ui";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { usePartnerProfile } from "@/components/partner/use-partner-profile";
import { PartnerScreen } from "@/components/partner/partner-screen";
import { AvailabilityGrid } from "@/components/partner/availability-grid";

function Loading() {
  return (
    <Screen>
      <BrandHeader tagline={false} />
      <div className="mt-16 flex flex-col items-center gap-3 text-muted" role="status">
        <span className="scale-150">
          <Spinner />
        </span>
      </div>
    </Screen>
  );
}

function CheckIcon() {
  return (
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </svg>
  );
}

export default function PartnerSetupPage() {
  const router = useRouter();
  const { t } = useI18n();
  const signedIn = useAuthGuard();
  const { status, profile } = usePartnerProfile();
  const applyAsPartner = useMutation(api.partners.applyAsPartner);
  const setWeeklyAvailability = useMutation(api.partners.setWeeklyAvailability);
  const slots = useQuery(
    api.partners.myWeeklyAvailability,
    profile && profile.status === "approved" ? { targetLanguage: profile.targetLanguage } : "skip",
  );

  const [retaking, setRetaking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const shouldRedirectHome = signedIn && status === "ready" && profile === null;
  const shouldRedirectTest = signedIn && status === "ready" && profile !== null && profile.status === "pending";

  useEffect(() => {
    if (shouldRedirectHome) router.replace("/partner");
    else if (shouldRedirectTest) router.replace("/partner/test");
  }, [shouldRedirectHome, shouldRedirectTest, router]);

  if (!signedIn || status === "loading" || shouldRedirectHome || shouldRedirectTest || profile === null) {
    return <Loading />;
  }

  async function onRetake() {
    setRetaking(true);
    try {
      await applyAsPartner({ targetLanguage: profile!.targetLanguage });
      router.push("/partner/test");
    } finally {
      setRetaking(false);
    }
  }

  async function onSaveAvailability(newSlots: Array<{ dayOfWeek: number; startMinute: number; endMinute: number; timezone: string }>) {
    setSaving(true);
    setSaved(false);
    try {
      await setWeeklyAvailability({ targetLanguage: profile!.targetLanguage, slots: newSlots });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  const approved = profile.status === "approved";

  return (
    <PartnerScreen onBack={() => router.push("/home")}>
      <section className="mt-6">
        <div className={approved ? "text-accent" : "text-danger"}>{approved ? <CheckIcon /> : <XIcon />}</div>
        <h2 className="mt-4 text-[26px] leading-tight font-bold">
          {t(approved ? "partner.setup.approvedTitle" : "partner.setup.notApprovedTitle")}
        </h2>
        <p className="mt-2 text-base text-muted">
          {t(approved ? "partner.setup.approvedBody" : "partner.setup.notApprovedBody")}
        </p>
        {profile.level ? (
          <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface-2 px-4 py-2 text-base font-semibold">
            {t("partner.setup.levelLabel")}: {t(`level.${profile.level}` as MessageKey)}
          </p>
        ) : null}

        {!approved ? (
          <div className="mt-6">
            <PrimaryButton type="button" busy={retaking} onClick={() => void onRetake()}>
              {t("partner.setup.retakeTest")}
            </PrimaryButton>
          </div>
        ) : null}
      </section>

      {approved ? (
        <section className="mt-8">
          {slots === undefined ? (
            <div className="flex justify-center text-muted" role="status">
              <Spinner />
            </div>
          ) : (
            <AvailabilityGrid initialSlots={slots} onSave={(s) => void onSaveAvailability(s)} saving={saving} saved={saved} />
          )}

          <div className="mt-6">
            <button
              type="button"
              onClick={() => router.push("/partner/dashboard")}
              className="h-14 w-full rounded-2xl border border-line-strong text-[17px] font-semibold"
            >
              {t("partner.setup.goDashboard")}
            </button>
          </div>
        </section>
      ) : null}
    </PartnerScreen>
  );
}
