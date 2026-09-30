"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAction } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, Screen } from "@/components/ui";

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function FindingStep({ bookingId, since }: { bookingId: Id<"roomBookings">; since: number }) {
  const { t } = useI18n();
  const router = useRouter();
  const cancelBooking = useAction(api.rooms.cancelBooking);
  const [elapsed, setElapsed] = useState(() => Date.now() - since);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - since), 1000);
    return () => clearInterval(id);
  }, [since]);

  async function onCancel() {
    setCancelling(true);
    try {
      await cancelBooking({ bookingId });
    } catch {
      // No payment was ever taken for an unmatched "now" request — safe to just leave either way.
    } finally {
      router.push("/rooms");
    }
  }

  return (
    <Screen>
      <BrandHeader tagline={false} />
      <div className="mt-16 flex flex-1 flex-col items-center text-center">
        <div className="relative grid size-32 place-items-center rounded-full border border-accent/40">
          <span className="absolute inset-2 animate-ping rounded-full border border-accent/30" />
          <SearchIcon />
        </div>
        <h1 className="mt-6 text-[26px] font-bold">{t("room.book.finding.title")}</h1>
        <p className="mt-2 text-lg font-semibold text-accent">{t("room.book.finding.elapsed", { time: formatElapsed(elapsed) })}</p>
        <p className="mt-3 text-base text-muted">{t("room.book.finding.body")}</p>
      </div>
      <div className="mt-auto pt-6">
        <button
          type="button"
          disabled={cancelling}
          onClick={() => void onCancel()}
          className="h-14 w-full rounded-2xl border border-line-strong text-[17px] font-semibold disabled:opacity-60"
        >
          {t("room.book.finding.cancel")}
        </button>
      </div>
    </Screen>
  );
}

function SearchIcon() {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
