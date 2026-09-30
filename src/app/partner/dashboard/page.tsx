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
import { usePartnerAlerts } from "@/components/partner/use-partner-alerts";
import { ToastStack } from "@/components/partner/toast-stack";

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

  const alerts = usePartnerAlerts(openNow, dashboard?.booked);

  const shouldRedirect = signedIn && status === "ready" && (profile === null || profile.status !== "approved");

  useEffect(() => {
    if (!shouldRedirect) return;
    router.replace(profile === null ? "/partner" : profile.status === "pending" ? "/partner/test" : "/partner/setup");
  }, [shouldRedirect, profile, router]);

  // Heartbeat while "available now" is on and this page is open.
  useEffect(() => {
    if (!profile?.availableNow) return;
    const id = setInterval(() => void heartbeat({ targetLanguage: profile!.targetLanguage }), HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [profile?.availableNow, heartbeat]);

  if (!signedIn || status === "loading" || shouldRedirect || profile === null) return <Loading />;

  async function onToggleAvailable() {
    setToggling(true);
    try {
      await setAvailableNow({ targetLanguage: profile!.targetLanguage, available: !profile!.availableNow });
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

  type NowItem = NonNullable<typeof openNow>[number];
  type BookedItem = NonNullable<typeof dashboard>["booked"][number];
  type OpenRoomEntry = { kind: "now"; sortAt: number; item: NowItem } | { kind: "booked"; sortAt: number; item: BookedItem };
  const openRoomEntries: OpenRoomEntry[] = [
    ...(openNow ?? []).map((r): OpenRoomEntry => ({ kind: "now", sortAt: r.matchDeadlineAt, item: r })),
    ...(dashboard?.booked ?? []).map((b): OpenRoomEntry => ({ kind: "booked", sortAt: b.scheduledStartAt ?? Number.POSITIVE_INFINITY, item: b })),
  ].sort((a, b) => a.sortAt - b.sortAt);
  const openRoomsLoading = openNow === undefined || dashboard === undefined;

  return (
    <PartnerScreen onBack={() => router.push("/home")}>
      <ToastStack toasts={alerts.toasts} onDismiss={alerts.dismissToast} />

      <div className="mt-6 flex items-center justify-between gap-3">
        <h2 className="text-[26px] leading-tight font-bold">{t("partner.dashboard.title")}</h2>
        {alerts.permission === "default" ? (
          <button
            type="button"
            onClick={alerts.requestNotifications}
            className="shrink-0 rounded-full border border-line-strong px-3 py-1.5 text-[13px] font-semibold hover:border-accent"
          >
            {t("partner.alerts.enable")}
          </button>
        ) : alerts.permission === "granted" ? (
          <span className="shrink-0 rounded-full bg-accent/15 px-3 py-1.5 text-[13px] font-semibold text-accent">
            {t("partner.alerts.on")}
          </span>
        ) : null}
      </div>
      {alerts.permission === "denied" ? (
        <p className="mt-1 text-[13px] text-muted">{t("partner.alerts.blocked")}</p>
      ) : null}

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
        <div className="flex items-center gap-2">
          <h3 className="text-[18px] font-bold">{t("partner.dashboard.openRooms")}</h3>
          {openNow && openNow.length > 0 ? (
            <span className="grid size-6 place-items-center rounded-full bg-accent text-[13px] font-bold text-accent-ink">
              {openNow.length}
            </span>
          ) : null}
        </div>
        {openRoomsLoading ? (
          <div className="mt-3 flex justify-center text-muted" role="status">
            <Spinner />
          </div>
        ) : openRoomEntries.length === 0 ? (
          <p className="mt-2 text-base text-muted">{t("partner.dashboard.noOpenRooms")}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {openRoomEntries.map((entry) =>
              entry.kind === "now" ? (
                <li key={`now-${entry.item._id}`} className="rounded-2xl border border-line bg-surface p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold break-words">{entry.item.scenario}</span>
                    <span className="shrink-0 rounded-full bg-accent/15 px-2.5 py-0.5 text-[13px] font-semibold text-accent">
                      {t("room.live.minSession", { n: entry.item.minutes })}
                    </span>
                  </div>
                  <p className="mt-1 text-base text-muted">
                    {t("partner.dashboard.learnerLevel")}: {t(`level.${entry.item.learnerLevel}` as MessageKey)}
                  </p>
                  {acceptError?.id === entry.item._id ? (
                    <p role="alert" className="mt-2 text-base text-danger">
                      {acceptError.message}
                    </p>
                  ) : null}
                  <div className="mt-3 flex gap-3">
                    <button
                      type="button"
                      onClick={() => setDetailsId(entry.item._id)}
                      className="h-11 flex-1 rounded-xl border border-line-strong text-base font-semibold"
                    >
                      {t("partner.dashboard.viewDetails")}
                    </button>
                    <PrimaryButton
                      type="button"
                      className="h-11 flex-1"
                      busy={acceptingId === entry.item._id}
                      onClick={() => void onAccept(entry.item._id)}
                    >
                      {t("partner.dashboard.accept")}
                    </PrimaryButton>
                  </div>
                </li>
              ) : (
                <li key={`booked-${entry.item._id}`}>
                  <button
                    type="button"
                    onClick={() => router.push(`/room/${entry.item._id}`)}
                    className="flex w-full flex-col gap-1 rounded-2xl border border-line bg-surface p-4 text-left hover:border-accent"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold break-words">{entry.item.scenario}</span>
                      <span className="shrink-0 rounded-full bg-accent/15 px-2.5 py-0.5 text-[13px] font-semibold text-accent">
                        {t(`room.home.status.${entry.item.status}` as MessageKey)}
                      </span>
                    </div>
                    <p className="text-base text-muted">
                      {entry.item.mode === "now" || entry.item.scheduledStartAt === null
                        ? t("room.home.now")
                        : new Intl.DateTimeFormat(lang === "hi" ? "hi-IN" : "en-GB", {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            hour: "numeric",
                            minute: "2-digit",
                          }).format(new Date(entry.item.scheduledStartAt))}
                      {" · "}
                      {t("room.live.minSession", { n: entry.item.minutes })}
                    </p>
                  </button>
                </li>
              ),
            )}
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
