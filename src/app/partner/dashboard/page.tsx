"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, PrimaryButton, Screen, Spinner, cx } from "@/components/ui";
import { Sheet } from "@/components/home/sheet";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { usePartnerProfile } from "@/components/partner/use-partner-profile";
import { PartnerScreen } from "@/components/partner/partner-screen";

const HEARTBEAT_MS = 60_000;
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

/** Payouts are recorded in INR paise (partnerEarningInrPaise) — shown in INR, the currency a partner is actually paid in. */
function inr(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

function errorCode(err: unknown): string | null {
  if (err instanceof ConvexError) {
    const data = err.data as { code?: unknown } | undefined;
    return typeof data?.code === "string" ? data.code : null;
  }
  return null;
}

export default function PartnerDashboardPage() {
  const router = useRouter();
  const { t, lang } = useI18n();
  const signedIn = useAuthGuard();
  const { status, profile } = usePartnerProfile();

  const setAvailableNow = useMutation(api.partners.setAvailableNow);
  const heartbeat = useMutation(api.partners.heartbeat);
  const acceptRoomRequest = useMutation(api.rooms.acceptRoomRequest);

  const openNow = useQuery(api.rooms.openNowRequests, profile?.status === "approved" ? {} : "skip");
  const dashboard = useQuery(api.rooms.partnerDashboard, profile?.status === "approved" ? {} : "skip");
  const history = useQuery(api.rooms.partnerSessionHistory, profile?.status === "approved" ? {} : "skip");

  const [detailsId, setDetailsId] = useState<Id<"roomBookings"> | null>(null);
  const [acceptingId, setAcceptingId] = useState<Id<"roomBookings"> | null>(null);
  const [acceptError, setAcceptError] = useState<{ id: Id<"roomBookings">; message: string } | null>(null);
  const [toggling, setToggling] = useState(false);

  const shouldRedirect = signedIn && status === "ready" && (profile === null || profile.status !== "approved");

  useEffect(() => {
    if (!shouldRedirect) return;
    router.replace(profile === null ? "/partner" : profile.status === "pending" ? "/partner/test" : "/partner/setup");
  }, [shouldRedirect, profile, router]);

  // Heartbeat while "available now" is on and this page is open.
  useEffect(() => {
    if (!profile?.availableNow) return;
    const id = setInterval(() => void heartbeat({ targetLanguage: "en" }), HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [profile?.availableNow, heartbeat]);

  if (!signedIn || status === "loading" || shouldRedirect || profile === null) return <Loading />;

  async function onToggleAvailable() {
    setToggling(true);
    try {
      await setAvailableNow({ targetLanguage: "en", available: !profile!.availableNow });
    } finally {
      setToggling(false);
    }
  }

  async function onAccept(bookingId: Id<"roomBookings">) {
    setAcceptingId(bookingId);
    setAcceptError(null);
    try {
      await acceptRoomRequest({ bookingId });
      router.push(`/room/${bookingId}`);
    } catch (err) {
      const code = errorCode(err);
      const message =
        code === "already_matched"
          ? t("partner.dashboard.alreadyTaken")
          : code === "expired"
            ? t("partner.dashboard.expired")
            : t("partner.become.error");
      setAcceptError({ id: bookingId, message });
    } finally {
      setAcceptingId(null);
    }
  }

  const weekStart = Date.now() - WEEK_MS;
  const weekHistory = (history ?? []).filter((h) => (h.scheduledStartAt ?? 0) >= weekStart);
  const weekPaid = weekHistory.filter((h) => h.payoutStatus !== null);
  const weekTotalPaise = weekPaid.reduce((acc, h) => acc + h.earningInrPaise, 0);

  const detailsRequest = openNow?.find((r) => r._id === detailsId) ?? null;

  return (
    <PartnerScreen onBack={() => router.push("/home")}>
      <h2 className="mt-6 text-[26px] leading-tight font-bold">{t("partner.dashboard.title")}</h2>

      <section className="mt-5 rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-base font-semibold">{t("partner.dashboard.availableNow")}</p>
            <p className="mt-1 text-base text-muted">{t("partner.dashboard.availableNowHint")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={profile.availableNow}
            aria-label={t("partner.dashboard.availableNow")}
            disabled={toggling}
            onClick={() => void onToggleAvailable()}
            className={cx(
              "relative h-8 w-14 shrink-0 rounded-full transition-colors disabled:opacity-60",
              profile.availableNow ? "bg-accent" : "bg-line-strong",
            )}
          >
            <span
              className={cx(
                "absolute top-1 size-6 rounded-full bg-white transition-transform",
                profile.availableNow ? "translate-x-7" : "translate-x-1",
              )}
            />
          </button>
        </div>
      </section>

      <section className="mt-6">
        <h3 className="text-[18px] font-bold">
          {t("partner.dashboard.requestsNow")}
          {openNow && openNow.length > 0 ? ` (${openNow.length})` : ""}
        </h3>
        {openNow === undefined ? (
          <div className="mt-3 flex justify-center text-muted" role="status">
            <Spinner />
          </div>
        ) : openNow.length === 0 ? (
          <p className="mt-2 text-base text-muted">{t("partner.dashboard.noRequests")}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {openNow.map((r) => (
              <li key={r._id} className="rounded-2xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold break-words">{r.scenario}</span>
                  <span className="shrink-0 rounded-full bg-accent/15 px-2.5 py-0.5 text-[13px] font-semibold text-accent">
                    {t("room.live.minSession", { n: r.minutes })}
                  </span>
                </div>
                <p className="mt-1 text-base text-muted">
                  {t("partner.dashboard.learnerLevel")}: {t(`level.${r.learnerLevel}` as MessageKey)}
                </p>
                {acceptError?.id === r._id ? (
                  <p role="alert" className="mt-2 text-base text-danger">
                    {acceptError.message}
                  </p>
                ) : null}
                <div className="mt-3 flex gap-3">
                  <button
                    type="button"
                    onClick={() => setDetailsId(r._id)}
                    className="h-11 flex-1 rounded-xl border border-line-strong text-base font-semibold"
                  >
                    {t("partner.dashboard.viewDetails")}
                  </button>
                  <PrimaryButton
                    type="button"
                    className="h-11 flex-1"
                    busy={acceptingId === r._id}
                    onClick={() => void onAccept(r._id)}
                  >
                    {t("partner.dashboard.accept")}
                  </PrimaryButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <h3 className="text-[18px] font-bold">{t("partner.dashboard.booked")}</h3>
        {dashboard === undefined ? (
          <div className="mt-3 flex justify-center text-muted" role="status">
            <Spinner />
          </div>
        ) : dashboard.booked.length === 0 ? (
          <p className="mt-2 text-base text-muted">{t("partner.dashboard.noBooked")}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {dashboard.booked.map((b) => (
              <li key={b._id}>
                <button
                  type="button"
                  onClick={() => router.push(`/room/${b._id}`)}
                  className="flex w-full flex-col gap-1 rounded-2xl border border-line bg-surface p-4 text-left hover:border-accent"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold break-words">{b.scenario}</span>
                    <span className="shrink-0 rounded-full bg-accent/15 px-2.5 py-0.5 text-[13px] font-semibold text-accent">
                      {t(`room.home.status.${b.status}` as MessageKey)}
                    </span>
                  </div>
                  <p className="text-base text-muted">
                    {b.mode === "now" || b.scheduledStartAt === null
                      ? t("room.home.now")
                      : new Intl.DateTimeFormat(lang === "hi" ? "hi-IN" : "en-GB", {
                          weekday: "short",
                          day: "numeric",
                          month: "short",
                          hour: "numeric",
                          minute: "2-digit",
                        }).format(new Date(b.scheduledStartAt))}
                    {" · "}
                    {t("room.live.minSession", { n: b.minutes })}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 rounded-2xl border border-accent bg-surface p-4">
        <button type="button" onClick={() => router.push("/partner/earnings")} className="flex w-full items-center justify-between gap-3 text-left">
          <div>
            <p className="text-base text-muted">{t("partner.dashboard.earningsWeek")}</p>
            <p className="text-[24px] font-bold">{inr(weekTotalPaise)}</p>
            <p className="text-base text-muted">{t("partner.dashboard.sessionsCompleted", { n: weekPaid.length })}</p>
          </div>
          <span aria-hidden="true" className="text-muted">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 5l7 7-7 7" />
            </svg>
          </span>
        </button>
      </section>

      {detailsRequest ? (
        <Sheet title={detailsRequest.scenario} onClose={() => setDetailsId(null)}>
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-base text-muted">
              {t("partner.dashboard.learnerLevel")}: <span className="font-semibold text-fg">{t(`level.${detailsRequest.learnerLevel}` as MessageKey)}</span>
            </p>
            <p className="text-base text-muted">{t("room.live.minSession", { n: detailsRequest.minutes })}</p>
            <PrimaryButton type="button" busy={acceptingId === detailsRequest._id} onClick={() => void onAccept(detailsRequest._id)}>
              {t("partner.dashboard.accept")}
            </PrimaryButton>
          </div>
        </Sheet>
      ) : null}
    </PartnerScreen>
  );
}
