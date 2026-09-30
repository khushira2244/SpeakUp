"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n/provider";
import { BackButton, BrandHeader, PrimaryButton, Screen } from "@/components/ui";
import type { RoomScriptDoc, RoomRole, RoomStateDoc } from "./types";

/** How long before the scheduled start the mic-permission prompt is worth showing — no point asking (and holding a live mic stream) hours in advance. */
const MIC_CHECK_LEAD_MS = 10 * 60_000;

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Independent, short-lived mic permission + level check — released as soon as the lobby unmounts, `enabled` goes false, or a real session starts (see use-room-audio.ts for the actual room capture). */
function useMicCheck(enabled: boolean) {
  const [status, setStatus] = useState<"checking" | "ok" | "blocked">("checking");
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let stopped = false;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        setStatus("ok");
        ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(data);
          const avg = data.reduce((a, b) => a + b, 0) / data.length;
          setLevel(Math.min(1, avg / 70));
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        if (!stopped) setStatus("blocked");
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      if (ctx && ctx.state !== "closed") void ctx.close().catch(() => undefined);
    };
  }, [enabled]);

  return { status, level };
}

export function Lobby({
  role,
  roomState,
  script,
  joining,
  joinError,
  onJoin,
  onBack,
}: {
  role: RoomRole;
  roomState: RoomStateDoc;
  script: RoomScriptDoc | null;
  joining: boolean;
  joinError: string | null;
  onJoin: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  const startAt = roomState.scheduledStartAt ?? now;
  const remainingMs = startAt - now;
  const micCheckEnabled = remainingMs <= MIC_CHECK_LEAD_MS;
  const mic = useMicCheck(micCheckEnabled);
  const otherJoined = role === "learner" ? roomState.partnerJoined : roomState.learnerJoined;
  const otherRoleWord = role === "learner" ? t("room.live.partnerRole") : t("room.live.learnerRole");
  const otherLabel = role === "learner" ? t("room.lobby.partnerLabel") : t("room.lobby.learnerLabel");
  const firstLine = script?.lines[0]?.text ?? null;
  const firstLineMeaning = script?.lines[0]?.meaning ?? null;

  return (
    <Screen>
      <div className="relative">
        <BackButton onClick={onBack} />
        <BrandHeader tagline={false} />
      </div>

      <div className="mt-6 flex flex-col items-center gap-1 rounded-2xl border border-line bg-surface p-5 text-center">
        <ClockIcon />
        <p className="mt-2 text-lg font-semibold">
          {remainingMs > 0 ? t("room.lobby.startsIn", { time: formatCountdown(remainingMs) }) : t("room.lobby.startsNow")}
        </p>
      </div>

      <section className="mt-4 rounded-2xl border border-line bg-surface p-5">
        <h2 className="text-base font-semibold">{t("room.lobby.micCheck")}</h2>
        {micCheckEnabled ? (
          <>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-line" aria-hidden="true">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-100"
                style={{ width: `${Math.round((mic.status === "ok" ? mic.level : 0) * 100)}%` }}
              />
            </div>
            {mic.status === "ok" ? (
              <p className="mt-2 flex items-center gap-1.5 text-base text-accent">
                <CheckIcon /> {t("room.lobby.micWorking")}
              </p>
            ) : mic.status === "blocked" ? (
              <p role="alert" className="mt-2 text-base text-danger">
                {t("mic.err.mic_blocked")}
              </p>
            ) : (
              <p className="mt-2 text-base text-muted">{t("mic.connecting")}</p>
            )}
          </>
        ) : (
          <p className="mt-2 text-base text-muted">{t("room.lobby.micCheckLater")}</p>
        )}
      </section>

      <section className="mt-4 rounded-2xl border border-line bg-surface p-5">
        <p className="text-base text-muted">{otherLabel}</p>
        <div className="mt-1 flex items-center gap-2">
          <p className="text-lg font-semibold">{otherRoleWord}</p>
          {otherJoined ? (
            <span className="text-accent">
              <CheckIcon />
            </span>
          ) : null}
        </div>
        <p className="text-base text-muted">{otherJoined ? t("room.lobby.joined", { name: otherRoleWord }) : t("room.lobby.notJoinedYet")}</p>
      </section>

      {firstLine ? (
        <section className="mt-4 rounded-2xl border border-line bg-surface p-5">
          <p className="text-base text-muted">{t("room.lobby.scriptLabel")}</p>
          <p className="mt-1 text-lg leading-snug">{firstLine}</p>
          {firstLineMeaning ? <p className="mt-0.5 text-base text-muted italic">({firstLineMeaning})</p> : null}
        </section>
      ) : null}

      {joinError ? (
        <p role="alert" className="mt-4 text-base text-danger">
          {joinError}
        </p>
      ) : null}

      <div className="mt-auto pt-6">
        <PrimaryButton type="button" busy={joining} disabled={joining || mic.status === "blocked"} onClick={onJoin}>
          {joining ? t("room.lobby.joining") : t("room.lobby.joinRoom")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}

function ClockIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function CheckIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
