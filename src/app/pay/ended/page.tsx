"use client";

import { useRouter } from "next/navigation";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, PrimaryButton, Screen } from "@/components/ui";
import { useAuthGuard } from "@/lib/use-auth-guard";

// The screen a learner sees when their pass has run out. Static: nothing decides
// yet when to show it; it is reachable at /pay/ended for now.
export default function PassEndedPage() {
  const router = useRouter();
  const { t } = useI18n();
  useAuthGuard();

  return (
    <Screen>
      <BrandHeader />
      <div className="mt-16 flex flex-1 flex-col items-center text-center">
        <div className="grid size-28 place-items-center rounded-full bg-surface-2 text-muted">
          <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
            <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
          </svg>
        </div>
        <h2 className="mt-8 text-[28px] leading-tight font-bold">{t("pay.endedTitle")}</h2>
        <p className="mt-3 text-base text-muted">{t("pay.endedBody")}</p>
      </div>
      <div className="pt-6">
        <PrimaryButton type="button" onClick={() => router.push("/pay")}>
          {t("pay.renew")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}
