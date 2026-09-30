"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n/provider";

/** How far ahead of a booked session's start to fire the "starting soon" alert. */
const STARTING_SOON_MS = 10 * 60_000;
const TOAST_LIFETIME_MS = 6_000;
/** How often the "starting soon" clock is re-checked — this is real-time-driven, not data-driven, since scheduledStartAt itself never changes. */
const TICK_MS = 15_000;

export type PartnerAlertToast = { id: string; message: string };

type NowLike = { _id: string; scenario: string };
type BookedLike = { _id: string; scenario: string; scheduledStartAt: number | null };

/**
 * In-app notifications for the partner dashboard: a toast (+ optional
 * browser Notification, once permission is granted) fires when a new
 * eligible "Now" request shows up, or a booked session is starting within
 * 10 minutes. No push service — this only fires while the tab is open,
 * driven entirely by the dashboard's own reactive Convex queries plus a
 * local clock tick for the time-based trigger.
 */
export function usePartnerAlerts(openNow: readonly NowLike[] | undefined, booked: readonly BookedLike[] | undefined) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<PartnerAlertToast[]>([]);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const seenNowIds = useRef<Set<string>>(new Set());
  const seenSoonIds = useRef<Set<string>>(new Set());
  const initializedNow = useRef(false);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) setPermission(Notification.permission);
  }, []);

  function pushToast(message: string) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), TOAST_LIFETIME_MS);
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
      try {
        new Notification("SpeakUp", { body: message });
      } catch {
        // Foreground toast above already covers the alert either way.
      }
    }
  }

  // New "Now" requests only — the first load seeds `seenNowIds` without alerting, so
  // whatever is already open when the dashboard mounts doesn't fire a spurious toast.
  useEffect(() => {
    if (openNow === undefined) return;
    if (!initializedNow.current) {
      for (const r of openNow) seenNowIds.current.add(r._id);
      initializedNow.current = true;
      return;
    }
    for (const r of openNow) {
      if (!seenNowIds.current.has(r._id)) {
        seenNowIds.current.add(r._id);
        pushToast(t("partner.alerts.newRequest", { scenario: r.scenario }));
      }
    }
    const live = new Set(openNow.map((r) => r._id));
    for (const id of seenNowIds.current) if (!live.has(id)) seenNowIds.current.delete(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNow]);

  // Booked sessions starting soon.
  useEffect(() => {
    function check() {
      if (booked === undefined) return;
      const now = Date.now();
      for (const b of booked) {
        if (b.scheduledStartAt === null) continue;
        const untilStart = b.scheduledStartAt - now;
        if (untilStart > 0 && untilStart <= STARTING_SOON_MS && !seenSoonIds.current.has(b._id)) {
          seenSoonIds.current.add(b._id);
          pushToast(t("partner.alerts.startingSoon", { scenario: b.scenario }));
        }
      }
    }
    check();
    const id = setInterval(check, TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booked]);

  function requestNotifications() {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    void Notification.requestPermission().then((p) => setPermission(p));
  }

  function dismissToast(id: string) {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }

  return { toasts, dismissToast, permission, requestNotifications };
}
