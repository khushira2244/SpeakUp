"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { BackButton, BrandHeader, PrimaryButton, Screen, Spinner } from "@/components/ui";
import { useAuthGuard } from "@/lib/use-auth-guard";

const LIVE_STATUSES = new Set(["confirmed", "in_progress"]);

function formatWhen(mode: "now" | "later", startAt: number | null, lang: string): string {
  if (mode === "now" || startAt === null) return "";
  return new Intl.DateTimeFormat(lang === "hi" ? "hi-IN" : "en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(startAt));
}

export default function RoomsHomePage() {
  const router = useRouter();
  const { t, lang } = useI18n();
  const signedIn = useAuthGuard();
  const bookings = useQuery(api.rooms.roomsHome, signedIn ? {} : "skip");

  return (
    <Screen>
      <div className="relative">
        <BackButton onClick={() => router.push("/home")} />
        <BrandHeader />
      </div>
      <div className="mt-8">
        <h2 className="text-[28px] leading-tight font-bold">{t("room.home.title")}</h2>
        <p className="mt-2 text-base text-muted">{t("room.home.subtitle")}</p>
      </div>

      <div className="mt-6">
        <PrimaryButton type="button" onClick={() => router.push("/rooms/new")}>
          {t("room.home.newRoom")}
        </PrimaryButton>
      </div>

      <div className="mt-8">
        <h3 className="text-base font-semibold text-muted">{t("room.home.upcoming")}</h3>
        {bookings === undefined ? (
          <div className="mt-6 flex flex-col items-center gap-3 text-muted" role="status">
            <Spinner />
          </div>
        ) : bookings.length === 0 ? (
          <p className="mt-4 text-base text-muted">{t("room.home.empty")}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {bookings.map((b) => {
              const when = formatWhen(b.mode, b.scheduledStartAt, lang);
              const dest = LIVE_STATUSES.has(b.status) ? `/room/${b._id}` : `/rooms/${b._id}`;
              return (
                <li key={b._id}>
                  <button
                    type="button"
                    onClick={() => router.push(dest)}
                    className="flex w-full flex-col gap-1 rounded-2xl border border-line bg-surface p-4 text-left hover:border-accent"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[17px] font-semibold break-words">{b.scenario}</span>
                      <span className="shrink-0 rounded-full bg-accent/15 px-2.5 py-0.5 text-[13px] font-semibold text-accent">
                        {t(`room.home.status.${b.status}` as MessageKey)}
                      </span>
                    </div>
                    <p className="text-base text-muted">
                      {b.mode === "now" ? t("room.home.now") : (when || t("room.home.later"))}
                      {" · "}
                      {t("room.live.minSession", { n: b.minutes })}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Screen>
  );
}
