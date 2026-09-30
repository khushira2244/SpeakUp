"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { cx, PrimaryButton, Screen } from "@/components/ui";
import { Sheet } from "@/components/home/sheet";
import type { RoomAudioApi } from "./use-room-audio";
import type { RoomRole, RoomScriptDoc, RoomStateDoc } from "./types";
import { CheckIcon } from "./lobby";

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Purely presentational — no Convex query of its own, so the /dev/room-preview page can drive it with mock data. The silence watcher lives in the page (see use-silence-watcher.ts). */
export function LiveRoomView({
  role,
  roomState,
  script,
  audio,
  onLeave,
  onReport,
}: {
  role: RoomRole;
  roomState: RoomStateDoc;
  script: RoomScriptDoc | null;
  audio: RoomAudioApi;
  onLeave: () => void;
  onReport: (reason: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState("");
  const [reportSent, setReportSent] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const currentLineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    currentLineRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [roomState.currentLineIndex]);

  const otherRoleWord = role === "learner" ? t("room.live.partnerRole") : t("room.live.learnerRole");
  const msRemaining = roomState.scheduledEndAt !== null ? Math.max(0, roomState.scheduledEndAt - now) : 0;
  const sessionMinutes =
    roomState.scheduledStartAt !== null && roomState.scheduledEndAt !== null
      ? Math.round((roomState.scheduledEndAt - roomState.scheduledStartAt) / 60_000)
      : null;

  const allTargetWords = useMemo(() => {
    if (!script) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of script.lines) {
      for (const word of line.words) {
        const key = word.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(word);
        }
      }
    }
    return out;
  }, [script]);
  const saidWords = useMemo(() => new Set(roomState.targetWordsSaid.map((w) => w.word.toLowerCase())), [roomState.targetWordsSaid]);

  const showStuckToLearner = role === "learner" && roomState.stuckCue;
  const showStuckToPartner = role === "partner" && roomState.stuckCue;
  const showWarning = roomState.warning !== null;

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
      <div className="flex items-center justify-between">
        <p className="text-lg font-bold">
          <span className="text-accent">Speak</span>Up
        </p>
        <button type="button" onClick={onLeave} className="text-base font-semibold text-danger">
          {t("room.live.leave")}
        </button>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-2xl border border-line bg-surface px-4 py-3">
        <div className="flex items-center gap-2">
          <ClockIcon />
          <div>
            <p className="text-lg leading-tight font-semibold tabular-nums">{formatClock(msRemaining)} {t("room.live.left")}</p>
            {sessionMinutes !== null ? <p className="text-base leading-tight text-muted">{t("room.live.minSession", { n: sessionMinutes })}</p> : null}
          </div>
        </div>
        {audio.phase === "connecting" ? <span className="text-base text-muted">{t("room.live.connecting")}</span> : null}
        {audio.connectionIssue === "reconnecting" ? <span className="text-base text-muted">{t("room.live.reconnecting")}</span> : null}
      </div>

      <div className="mt-3 flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
        <span
          aria-hidden="true"
          className={cx("size-3 rounded-full", audio.remoteSpeaking ? "animate-pulse bg-accent" : "bg-line-strong")}
        />
        <div>
          <p className="text-lg font-semibold">{otherRoleWord}</p>
          <p className="text-base text-muted">{audio.remoteSpeaking ? t("room.live.speaking") : " "}</p>
        </div>
      </div>

      {showWarning ? (
        <div role="alert" className="mt-3 rounded-2xl border border-danger/60 bg-danger/10 p-4">
          <div className="flex items-start gap-2">
            <WarningIcon />
            <div>
              <p className="text-base font-semibold text-danger">{t("room.live.warningTitle")}</p>
              <p className="text-base text-danger">{t("room.live.warningBody")}</p>
            </div>
          </div>
        </div>
      ) : null}

      {showStuckToLearner ? (
        <div role="status" className="mt-3 rounded-2xl border border-amber-500/50 bg-amber-500/10 p-4">
          <p className="text-base font-semibold text-amber-300">{t("room.live.stuckLearnerTitle")}</p>
          <p className="text-base text-amber-200/90">{t("room.live.stuckLearnerBody")}</p>
        </div>
      ) : null}

      {audio.connectionIssue === "transcription_lost" ? (
        <p role="status" className="mt-3 text-base text-muted">
          {t("room.live.transcriptionLost")}
        </p>
      ) : null}

      {script ? (
        <div className="mt-4 max-h-[38vh] flex-1 space-y-2 overflow-y-auto rounded-2xl border border-line bg-surface p-3">
          {script.lines.map((line, i) => {
            const mine = line.role === role;
            const isCurrent = i === roomState.currentLineIndex;
            const isDone = roomState.doneLineIndices.includes(i);
            return (
              <div
                key={i}
                ref={isCurrent ? currentLineRef : undefined}
                className={cx(
                  "rounded-xl border p-3 transition-colors",
                  isCurrent ? "border-accent bg-accent/10" : "border-transparent",
                  !isCurrent && !isDone ? "opacity-70" : null,
                )}
              >
                <div className="flex items-center gap-1.5">
                  {isDone ? (
                    <span className="text-accent">
                      <CheckIcon size={15} />
                    </span>
                  ) : null}
                  <span className="text-base font-semibold text-muted">{mine ? t("room.live.you") : otherRoleWord}</span>
                </div>
                <p className="text-lg leading-snug">{line.text}</p>
                {line.meaning ? <p className="mt-0.5 text-base text-muted italic">({line.meaning})</p> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {showStuckToPartner ? (
        <button
          type="button"
          onClick={() => {
            /* purely informational — there is no server action to acknowledge it, it clears on the learner's next turn */
          }}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-base font-semibold text-amber-300"
        >
          <SlowIcon /> {t("room.live.readSlowlyCue")}
          <span className="text-amber-200/70">({t("room.live.readSlowlyHint")})</span>
        </button>
      ) : null}

      <div className="mt-3 rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-center gap-2 text-base text-muted">
          <WaveIcon />
          <span>{t("room.live.transcriptLabel")}</span>
        </div>
        <p className="mt-1 min-h-7 text-lg leading-snug break-words">{audio.liveText || "…"}</p>
      </div>

      {role === "learner" && allTargetWords.length > 0 ? (
        <div className="mt-3">
          <p className="text-base text-muted">{t("room.live.targetWords")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {allTargetWords.map((word) => {
              const said = saidWords.has(word.toLowerCase());
              return (
                <span
                  key={word}
                  className={cx(
                    "flex items-center gap-1 rounded-full border px-3 py-1.5 text-base",
                    said ? "border-accent bg-accent/15 text-fg" : "border-line-strong text-muted",
                  )}
                >
                  {word}
                  {said ? (
                    <span className="text-accent">
                      <CheckIcon size={14} />
                    </span>
                  ) : null}
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      {audio.errorCode ? (
        <p role="alert" className="mt-3 text-base text-danger">
          {t(`mic.err.${audio.errorCode}` as MessageKey)}
        </p>
      ) : null}

      <div className="mt-auto grid grid-cols-3 gap-3 pt-5">
        <ControlButton label={audio.muted ? t("room.live.unmute") : t("room.live.mute")} active={audio.muted} onClick={audio.toggleMute}>
          {audio.muted ? <MicOffIcon /> : <MicIcon />}
        </ControlButton>
        <ControlButton label={t("room.live.report")} onClick={() => setReportOpen(true)}>
          <FlagIcon />
        </ControlButton>
        <ControlButton label={t("room.live.leave")} danger onClick={onLeave}>
          <PhoneOffIcon />
        </ControlButton>
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

function ControlButton({
  label,
  active,
  danger,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cx(
        "flex flex-col items-center gap-1.5 rounded-2xl border py-3 text-base",
        danger
          ? "border-danger/50 bg-danger/10 text-danger"
          : active
            ? "border-accent bg-accent/15 text-fg"
            : "border-line-strong bg-surface-2 text-fg hover:border-accent",
      )}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function ClockIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 text-danger" aria-hidden="true">
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L14.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}

function SlowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function WaveIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-accent" aria-hidden="true">
      <rect x="3" y="10" width="2.5" height="4" rx="1.25" />
      <rect x="7.5" y="6" width="2.5" height="12" rx="1.25" />
      <rect x="12" y="3" width="2.5" height="18" rx="1.25" />
      <rect x="16.5" y="8" width="2.5" height="8" rx="1.25" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 18v4" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l18 18" />
      <path d="M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-.4 1.5M15 15a3 3 0 0 1-5.9-1" />
      <path d="M19 10v1a7 7 0 0 1-9.9 6.4M5 10v1a7 7 0 0 0 1 3.6" />
      <path d="M12 18v4" />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 21V4" />
      <path d="M5 4h13l-3 4 3 4H5" />
    </svg>
  );
}

function PhoneOffIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l18 18" />
      <path d="M10.7 6.3a15.6 15.6 0 0 1 6 2.9l1.6-1.6a1 1 0 0 1 1.4 0l2 2a1 1 0 0 1 0 1.4l-2 2a1 1 0 0 1-1.4 0" />
      <path d="M14.3 16.7A15.6 15.6 0 0 1 5.4 10l1.5-1.5a1 1 0 0 0 .2-1.1L5 3.7a1 1 0 0 0-1.4-.2l-2 1.6C1 5.6 .8 6.4 1 7.2a19.6 19.6 0 0 0 4.4 7.4 19.6 19.6 0 0 0 7.4 4.4c.8.2 1.6 0 2.1-.6l1.6-2a1 1 0 0 0-.2-1.4l-3.7-2.1a1 1 0 0 0-1 0" />
    </svg>
  );
}
