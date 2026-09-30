"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, Screen, Spinner, cx } from "@/components/ui";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { usePartnerProfile } from "@/components/partner/use-partner-profile";
import { PartnerScreen } from "@/components/partner/partner-screen";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

function inr(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

type ChipKind = "earned" | "held" | "paid" | "notPaid";

function chipFor(payoutStatus: "earned" | "held" | "paid" | null): ChipKind {
  return payoutStatus ?? "notPaid";
}

const CHIP_STYLE: Record<ChipKind, string> = {
  earned: "bg-accent/15 text-accent",
  held: "bg-[#ffc247]/20 text-[#ffc247]",
  paid: "bg-[#3ddc97]/20 text-[#3ddc97]",
  notPaid: "bg-danger/15 text-danger",
};

export default function PartnerEarningsPage() {
  const router = useRouter();
  const { t, lang } = useI18n();
  const signedIn = useAuthGuard();
  const { status, profile } = usePartnerProfile();
  const history = useQuery(api.rooms.partnerSessionHistory, profile?.status === "approved" ? {} : "skip");

  const shouldRedirect = signedIn && status === "ready" && (profile === null || profile.status !== "approved");

  useEffect(() => {
    if (!shouldRedirect) return;
    router.replace(profile === null ? "/partner" : profile.status === "pending" ? "/partner/test" : "/partner/setup");
  }, [shouldRedirect, profile, router]);

  if (!signedIn || status === "loading" || shouldRedirect || profile === null) return <Loading />;

  const weekStart = Date.now() - WEEK_MS;
  const weekTotal = (history ?? [])
    .filter((h) => (h.scheduledStartAt ?? 0) >= weekStart && h.payoutStatus !== null)
    .reduce((acc, h) => acc + h.earningInrPaise, 0);

  return (
    <PartnerScreen onBack={() => router.push("/partner/dashboard")}>
      <h2 className="mt-6 text-[26px] leading-tight font-bold">{t("partner.earnings.title")}</h2>

      <section className="mt-5 rounded-2xl border border-accent bg-surface p-4">
        <p className="text-base text-muted">{t("partner.earnings.thisWeek")}</p>
        <p className="text-[28px] font-bold">{inr(weekTotal)}</p>
      </section>

      <section className="mt-6">
        <h3 className="text-[18px] font-bold">{t("partner.earnings.history")}</h3>
        {history === undefined ? (
          <div className="mt-3 flex justify-center text-muted" role="status">
            <Spinner />
          </div>
        ) : history.length === 0 ? (
          <p className="mt-2 text-base text-muted">{t("partner.earnings.empty")}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {history.map((h) => {
              const chip = chipFor(h.payoutStatus);
              return (
                <li key={h._id} className="rounded-2xl border border-line bg-surface p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold break-words">{h.scenario}</p>
                      <p className="mt-1 text-base text-muted">
                        {h.scheduledStartAt
                          ? new Intl.DateTimeFormat(lang === "hi" ? "hi-IN" : "en-GB", {
                              day: "numeric",
                              month: "short",
                            }).format(new Date(h.scheduledStartAt))
                          : ""}
                        {" · "}
                        {t("room.live.minSession", { n: h.minutes })}
                      </p>
                    </div>
                    <span className={cx("shrink-0 rounded-full px-2.5 py-1 text-[13px] font-semibold", CHIP_STYLE[chip])}>
                      {chip === "notPaid" ? t("partner.earnings.status.notPaid") : `${t(`partner.earnings.status.${chip}` as MessageKey)}${chip !== "held" ? ` ${inr(h.earningInrPaise)}` : ""}`}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </PartnerScreen>
  );
}
