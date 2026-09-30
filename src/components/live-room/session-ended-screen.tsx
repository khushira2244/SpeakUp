"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { PrimaryButton, Screen, cx } from "@/components/ui";
import { Sheet } from "@/components/home/sheet";
import type { RoomRole } from "./types";

export type EndedReason = "violation" | "completed" | "no_show" | "cancelled" | "left";

export function SessionEndedScreen({
  reason,
  role,
  violatorRole,
  bookingId,
  onReport,
}: {
  reason: EndedReason;
  role: RoomRole;
  violatorRole: RoomRole | null;
  bookingId: string;
  onReport: (reason: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState("");
  const [reportSent, setReportSent] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);

  const otherRole: RoomRole = role === "learner" ? "partner" : "learner";
  const noShowTitleKey: MessageKey = otherRole === "partner" ? "room.ended.noShowPartnerTitle" : "room.ended.noShowLearnerTitle";
  const violationBodyKey: MessageKey = violatorRole === role ? "room.ended.violationBodyYou" : "room.ended.violationBodyOther";

  const content =
    reason === "violation"
      ? { icon: <ShieldIcon />, title: t("room.ended.violationTitle"), subtitle: t("room.ended.notCharged"), body: t(violationBodyKey), showSteps: true }
      : reason === "no_show"
        ? { icon: <XIcon />, title: t(noShowTitleKey), subtitle: t("room.ended.notCharged"), body: t("room.ended.noShowBody"), showSteps: false }
        : reason === "cancelled"
          ? { icon: <XIcon />, title: t("room.ended.cancelledTitle"), subtitle: null, body: null, showSteps: false }
          : reason === "left"
            ? { icon: <CheckCircleIcon />, title: t("room.ended.leftTitle"), subtitle: null, body: null, showSteps: false }
            : { icon: <CheckCircleIcon />, title: t("room.ended.completedTitle"), subtitle: null, body: t("room.ended.completedBody"), showSteps: false };

  async function submitReport() {
    if (reportText.trim().length === 0) return;
    setReportBusy(true);
    try {
      await onReport(reportText.trim());
      setReportSent(true);
    } finally {
      setReportBusy(false);
    }
  }

  return (
    <Screen>
      <div className="mt-10 flex flex-1 flex-col items-center text-center">
        <span className={reason === "violation" || reason === "no_show" || reason === "cancelled" ? "text-danger" : "text-accent"}>{content.icon}</span>
        <h1 className="mt-4 text-[26px] font-bold">{content.title}</h1>
        {content.subtitle ? <p className="mt-1 text-lg text-muted">{content.subtitle}</p> : null}
        {content.body ? <p className="mt-4 text-base text-muted">{content.body}</p> : null}

        {content.showSteps ? (
          <div className="mt-6 w-full rounded-2xl border border-line bg-surface p-5 text-left">
            <p className="text-base font-semibold">{t("room.ended.whatNext")}</p>
            <ol className="mt-3 flex flex-col gap-3">
              {([t("room.ended.step1"), t("room.ended.step2"), t("room.ended.step3")] as const).map((step, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-base font-semibold">{i + 1}</span>
                  <span className="text-base">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>

      <div className="mt-auto flex flex-col gap-3 pt-6">
        {reason === "violation" || reason === "no_show" ? (
          <button
            type="button"
            onClick={() => setReportOpen(true)}
            className="flex h-14 w-full items-center justify-center rounded-2xl border border-line-strong text-[17px] font-semibold"
          >
            {t("room.ended.reportDetails")}
          </button>
        ) : null}
        {reason === "no_show" && otherRole === "partner" ? (
          <PrimaryButton type="button" onClick={() => router.push("/rooms/new")}>
            {t("room.ended.bookAgain")}
          </PrimaryButton>
        ) : null}
        {reason === "completed" && role === "learner" ? (
          <PrimaryButton type="button" onClick={() => router.push(`/room/${bookingId}/report`)}>
            {t("room.ended.viewReport")}
          </PrimaryButton>
        ) : null}
        <button
          type="button"
          onClick={() => router.push("/rooms")}
          className={cx(
            "flex h-14 w-full items-center justify-center rounded-2xl text-[17px] font-semibold",
            (reason === "no_show" && otherRole === "partner") || (reason === "completed" && role === "learner")
              ? "border border-line-strong"
              : "bg-accent text-accent-ink",
          )}
        >
          {t("room.ended.backToRooms")}
        </button>
      </div>

      {reportOpen ? (
        <Sheet
          title={t("room.report.title")}
          onClose={() => {
            setReportOpen(false);
            setReportText("");
            setReportSent(false);
          }}
        >
          {reportSent ? (
            <p className="mt-4 text-lg">{t("room.report.sent")}</p>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              <textarea
                value={reportText}
                onChange={(e) => setReportText(e.target.value)}
                placeholder={t("room.report.placeholder")}
                rows={4}
                maxLength={500}
                className="w-full rounded-2xl border border-line bg-surface-2 p-3 text-base text-fg placeholder:text-placeholder focus:border-accent focus:outline-none"
              />
              <PrimaryButton type="button" busy={reportBusy} disabled={reportText.trim().length === 0} onClick={() => void submitReport()}>
                {t("room.report.submit")}
              </PrimaryButton>
            </div>
          )}
        </Sheet>
      ) : null}
    </Screen>
  );
}

function ShieldIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" />
      <path d="M12 8v5M12 16h.01" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </svg>
  );
}
