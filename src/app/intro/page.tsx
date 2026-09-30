"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth } from "convex/react";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, PrimaryButton, Screen } from "@/components/ui";

const STEPS: ReadonlyArray<{ title: MessageKey; body: MessageKey }> = [
  { title: "intro.s1.title", body: "intro.s1.body" },
  { title: "intro.s2.title", body: "intro.s2.body" },
  { title: "intro.s3.title", body: "intro.s3.body" },
];

// A showcase: it explains the app and takes no input. The only control is the button.
export default function IntroPage() {
  const router = useRouter();
  const { t } = useI18n();
  const { isLoading, isAuthenticated } = useConvexAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/auth");
  }, [isLoading, isAuthenticated, router]);

  return (
    <Screen>
      <BrandHeader tagline={false} />

      <section className="mt-10 select-none">
        <h2 className="text-center text-[30px] leading-tight font-bold">{t("intro.headline")}</h2>

        <h3 className="mt-10 text-base font-semibold text-muted">{t("intro.how")}</h3>
        <ol className="mt-4 grid gap-6">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex items-start gap-4">
              <span
                aria-hidden="true"
                className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-base font-bold text-accent-ink"
              >
                {i + 1}
              </span>
              <div>
                <p className="text-[19px] leading-snug font-semibold">{t(step.title)}</p>
                <p className="mt-1 text-base text-muted">{t(step.body)}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="mt-auto pt-10">
        <PrimaryButton type="button" onClick={() => router.push("/learn")}>
          {t("intro.start")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}
