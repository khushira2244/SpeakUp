"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAction, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, PrimaryButton, Screen, Spinner } from "@/components/ui";
import { useAuthGuard } from "@/lib/use-auth-guard";

function Loading({ text }: { text: string }) {
  return (
    <Screen>
      <BrandHeader tagline={false} />
      <div className="mt-16 flex flex-col items-center gap-3 text-muted" role="status">
        <span className="scale-150">
          <Spinner />
        </span>
        <p className="text-base">{text}</p>
      </div>
    </Screen>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-base text-muted">{label}</p>
      <p className="mt-1 text-[22px] font-bold">{value}</p>
    </div>
  );
}

export default function RoomReportPage() {
  const params = useParams<{ bookingId: string }>();
  const bookingId = params.bookingId as Id<"roomBookings">;
  const router = useRouter();
  const { t } = useI18n();
  const signedIn = useAuthGuard();

  const report = useQuery(api.liveRoom.report, signedIn ? { bookingId } : "skip");
  const generateReport = useAction(api.liveRoom.generateReport);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (report === undefined || report !== null || startedRef.current) return;
    startedRef.current = true;
    void generateReport({ bookingId }).catch((err) => {
      setError(err instanceof Error ? err.message : t("room.book.error"));
    });
  }, [report, bookingId, generateReport, t]);

  if (report === undefined) return <Loading text={t("common.loading")} />;
  if (report === null) {
    if (error) {
      return (
        <Screen>
          <BrandHeader tagline={false} />
          <p role="alert" className="mt-16 text-center text-base text-danger">
            {error}
          </p>
        </Screen>
      );
    }
    return <Loading text={t("room.sessionReport.generating")} />;
  }

  const stats = [
    { label: t("room.sessionReport.stats.linesDone"), value: `${report.linesDone}/${report.totalLearnerLines}` },
    { label: t("room.sessionReport.stats.targetWords"), value: String(report.targetWordsUsed.length) },
    { label: t("room.sessionReport.stats.longestPause"), value: t("room.sessionReport.seconds", { n: Math.round(report.longestPauseMs / 1000) }) },
    { label: t("room.sessionReport.stats.speakingSpeed"), value: t("room.sessionReport.wpm", { n: report.speakingSpeedWpm }) },
    { label: t("room.sessionReport.stats.stuckCount"), value: String(report.stuckCount) },
    { label: t("room.sessionReport.stats.talkShare"), value: t("room.sessionReport.percent", { n: report.talkSharePercent }) },
  ];

  return (
    <Screen>
      <BrandHeader tagline={false} />
      <div className="mt-8 text-center">
        <h1 className="text-[28px] leading-tight font-bold">{t("room.sessionReport.title")}</h1>
        <p className="mt-2 text-base text-muted">{t("room.sessionReport.subtitle")}</p>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3">
        {stats.map((s) => (
          <StatCard key={s.label} label={s.label} value={s.value} />
        ))}
      </div>

      <section className="mt-6 rounded-2xl border border-accent/40 bg-accent/10 p-4">
        <h2 className="text-base font-semibold">{t("room.sessionReport.feedbackTitle")}</h2>
        <p className="mt-2 text-base break-words">{report.feedback}</p>
      </section>

      {report.wordsMovedToCanUse.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-base font-semibold">{t("room.sessionReport.movedTitle")}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {report.wordsMovedToCanUse.map((w) => (
              <span key={w} className="rounded-full bg-accent/15 px-3 py-1.5 text-base font-semibold text-accent">
                {w}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <div className="mt-auto flex flex-col gap-3 pt-8">
        <button
          type="button"
          onClick={() => router.push("/rooms/new")}
          className="h-14 w-full rounded-2xl border border-line-strong text-[17px] font-semibold"
        >
          {t("room.sessionReport.practiseMissed")}
        </button>
        <PrimaryButton type="button" onClick={() => router.push("/rooms")}>
          {t("room.sessionReport.backToRooms")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}
