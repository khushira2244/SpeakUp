"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, PrimaryButton, Screen } from "@/components/ui";

export function NoPartnerStep({
  bookingId,
  targetLanguage,
  minutes,
  level,
}: {
  bookingId: Id<"roomBookings">;
  targetLanguage: "en" | "de";
  minutes: 5 | 10 | 15;
  level: "starting" | "basic" | "intermediate" | "confident";
}) {
  const { t, lang } = useI18n();
  const router = useRouter();
  const slots = useQuery(api.rooms.availableSlots, { targetLanguage, minutes, level });
  const joinWaitlist = useMutation(api.rooms.joinWaitlist);
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);

  const nearest = slots && slots.length > 0 ? slots[0]! : null;

  async function onJoinWaitlist() {
    setBusy(true);
    try {
      await joinWaitlist({ targetLanguage, minutes, fromBookingId: bookingId });
      setJoined(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <BrandHeader tagline={false} />
      <div className="mt-12 flex flex-1 flex-col items-center text-center">
        <XCircleIcon />
        <h1 className="mt-4 text-[26px] font-bold">{t("room.book.noPartner.title")}</h1>
        <p className="mt-2 text-base text-muted">{t("room.book.noPartner.body")}</p>

        <div className="mt-6 flex w-full flex-col gap-3">
          <div className="rounded-2xl border border-line bg-surface p-4 text-left">
            <p className="text-base text-muted">{t("room.book.noPartner.nearestSlot")}</p>
            <p className="mt-1 text-[19px] font-bold">
              {nearest
                ? new Intl.DateTimeFormat(lang === "hi" ? "hi-IN" : "en-GB", {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  }).format(new Date(nearest.startAt))
                : t("room.book.noPartner.noSlot")}
            </p>
          </div>

          <div className="rounded-2xl border border-line bg-surface p-4 text-left">
            <p className="text-base text-muted">{t("room.book.noPartner.joinWaitlist")}</p>
            {joined ? (
              <p className="mt-2 text-base font-semibold text-accent">{t("room.book.noPartner.waitlisted")}</p>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void onJoinWaitlist()}
                className="mt-2 h-11 rounded-xl border border-line-strong px-4 text-base font-semibold disabled:opacity-60"
              >
                {t("room.book.noPartner.joinWaitlist")}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-3 pt-6">
        <PrimaryButton type="button" onClick={() => router.push("/rooms/new")}>
          {t("room.book.noPartner.pickTime")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}

function XCircleIcon() {
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-danger" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </svg>
  );
}
