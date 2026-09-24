"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth } from "convex/react";
import { LANGUAGES, isSupportedLang } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, ChoiceRow, PrimaryButton, Screen } from "@/components/ui";

export default function LanguagePage() {
  const router = useRouter();
  const { lang, setLang, t } = useI18n();
  const { isAuthenticated } = useConvexAuth();

  // Already signed in: this screen is only for first-time setup.
  useEffect(() => {
    if (isAuthenticated) router.replace("/goal");
  }, [isAuthenticated, router]);

  return (
    <Screen>
      <BrandHeader />

      <section className="mt-10">
        <h2 className="text-[28px] leading-tight font-bold">{t("lang.title")}</h2>
        <p className="mt-2 text-base text-muted">{t("lang.subtitle")}</p>

        <div
          role="radiogroup"
          aria-label={t("lang.groupLabel")}
          className="mt-6 flex flex-col gap-3"
        >
          {LANGUAGES.map((l) => (
            <ChoiceRow
              key={l.code}
              name="language"
              value={l.code}
              lang={l.code}
              checked={lang === l.code}
              // The UI switches language the moment a row is picked.
              onChange={(code) => {
                if (isSupportedLang(code)) setLang(code);
              }}
            >
              {l.nativeName}
            </ChoiceRow>
          ))}
        </div>
      </section>

      <div className="mt-auto pt-8">
        <PrimaryButton type="button" onClick={() => router.push("/auth")}>
          {t("common.continue")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}
