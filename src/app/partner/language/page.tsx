"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, ChoicePill, PrimaryButton, Screen, Spinner } from "@/components/ui";
import { useAuthGuard } from "@/lib/use-auth-guard";
import type { TargetLang } from "@/lib/setup-draft";

const OPTIONS: ReadonlyArray<{ value: TargetLang; labelKey: "partner.language.en" | "partner.language.de" }> = [
  { value: "en", labelKey: "partner.language.en" },
  { value: "de", labelKey: "partner.language.de" },
];

/**
 * Shown once, right after choosing "Help others practise and earn" on /mode.
 * Only "en" overlaps with knownLanguages (en/hi/te) — see updateProfile's
 * rules in convex/users.ts — so choosing "de" leaves knownLanguages alone;
 * the partner's actual German ability is what the speaking test right after
 * this screen verifies, independent of knownLanguages.
 */
export default function PartnerLanguagePage() {
  const router = useRouter();
  const { t } = useI18n();
  const signedIn = useAuthGuard();
  const me = useQuery(api.users.me, signedIn ? {} : "skip");
  const updateProfile = useMutation(api.users.updateProfile);
  const applyAsPartner = useMutation(api.partners.applyAsPartner);

  const [choice, setChoice] = useState<TargetLang | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onContinue() {
    if (choice === null || busy || !me) return;
    setBusy(true);
    setError(null);
    try {
      const known = me.knownLanguages ?? [];
      if (choice === "en" && !known.includes("en") && me.primaryLanguage && me.targetLanguage && me.gender) {
        await updateProfile({
          knownLanguages: [...known, "en"],
          primaryLanguage: me.primaryLanguage,
          targetLanguage: me.targetLanguage,
          gender: me.gender,
        });
      }
      await applyAsPartner({ targetLanguage: choice });
      router.push("/partner/test");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("partner.language.error"));
      setBusy(false);
    }
  }

  if (!signedIn || me === undefined) {
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

  return (
    <Screen>
      <BrandHeader />

      <section className="mt-8">
        <h2 className="text-[28px] leading-tight font-bold">{t("partner.language.title")}</h2>
        <p className="mt-2 text-base text-muted">{t("partner.language.subtitle")}</p>

        <div className="mt-6 flex flex-wrap gap-2">
          {OPTIONS.map((o) => (
            <ChoicePill key={o.value} name="partner-language" value={o.value} checked={choice === o.value} onChange={(v) => setChoice(v as TargetLang)}>
              {t(o.labelKey)}
            </ChoicePill>
          ))}
        </div>

        {error ? (
          <p role="alert" className="mt-4 text-base text-danger">
            {error}
          </p>
        ) : null}
      </section>

      <div className="mt-auto pt-6">
        <PrimaryButton type="button" busy={busy} disabled={choice === null} onClick={() => void onContinue()}>
          {t("common.continue")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}
