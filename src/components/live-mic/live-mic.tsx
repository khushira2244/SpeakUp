"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { PrimaryButton } from "@/components/ui";
import {
  StreamError,
  StreamSession,
  type LiveMicError,
  type MicWord,
  type StreamResult,
} from "./stream-session";

export type { LiveMicError, MicWord };

export type MicState = "idle" | "listening" | "transcript" | "done" | "error";

export type LiveMicResult = StreamResult & {
  /** The speech_model the backend told us to use for this stream. */
  speechModel: string;
};

export type LiveMicProps = {
  /** "target": speaking the language being learned. "own": answering in the learner's own language. */
  purpose: "target" | "own";
  /** Stream for a specific owned goal (a partner's speaking test) instead of the caller's active goal. */
  goalId?: Id<"goals">;
  /**
   * Called exactly once per accepted attempt with the FINAL transcript, word
   * timings and confidences (partials are never passed here).
   *   stopOn "manual":     when the learner taps Done.
   *   stopOn "first-turn": as soon as the first turn is final. The model ends a
   *                        turn at a pause in speech, so this suits single
   *                        words, not long answers.
   */
  onFinal: (result: LiveMicResult) => void;
  /** "mic_blocked" means permission denied / no microphone: show the mic-blocked screen. */
  onError?: (code: LiveMicError) => void;
  onStateChange?: (state: MicState) => void;
  /** Live text (finals so far + current partial). Display only: never save it. */
  onLive?: (text: string) => void;
  /** "manual" (default): the learner taps the mic to stop, then Done. "first-turn": stops itself at the first pause (single words). */
  stopOn?: "manual" | "first-turn";
  /** Stops listening automatically and shows a timer bar. */
  maxSeconds?: number;
  idleText?: string;
  listeningText?: string;
  /** Line under the listening title (default "Speak now"). */
  listeningSubText?: string;
  /** Title of the done state (default "Great!"): pass something neutral in a test. */
  doneTitle?: string;
  doneText?: string;
  /** Label above the transcript box, e.g. "Your answer (in Hindi)". */
  transcriptLabel?: string;
  /**
   * "full" (default): big mic, transcript box, Done button.
   * "compact": a small "Speak instead" pill for filling a text box. It accepts
   * automatically when the learner stops (onFinal), then returns to idle.
   */
  variant?: "full" | "compact";
  /** Compact only: label of the idle pill. */
  compactLabel?: string;
  /** Show the Done button. Defaults to true when stopOn is "manual". */
  showDone?: boolean;
  /** first-turn only: how long the transcript is shown before the done check. */
  settleMs?: number;
  disabled?: boolean;
  /** Development hooks for the /dev/mic page. */
  debug?: {
    onEvent?: (type: string, detail?: unknown) => void;
    onConnection?: (info: { speechModel: string; sampleRate: number | null }) => void;
    nativeSampleRate?: boolean;
  };
};

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function LiveMic(props: LiveMicProps) {
  const { purpose, stopOn = "manual", maxSeconds, settleMs = 700 } = props;
  const { t } = useI18n();
  const convex = useConvex();

  const [state, setState] = useState<MicState>("idle");
  const [connecting, setConnecting] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [result, setResult] = useState<LiveMicResult | null>(null);
  const [errorCode, setErrorCode] = useState<LiveMicError | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);

  const sessionRef = useRef<StreamSession | null>(null);
  const finishingRef = useRef(false);
  const acceptedRef = useRef(false);
  const startedAtRef = useRef(0);
  const speechModelRef = useRef("");
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest props, readable from long-lived callbacks without stale closures.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  const changeState = useCallback((next: MicState) => {
    setState(next);
    latest.current.onStateChange?.(next);
  }, []);

  const fail = useCallback(
    (code: LiveMicError) => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
      setConnecting(false);
      setLevel(0);
      setErrorCode(code);
      changeState("error");
      latest.current.onError?.(code);
    },
    [changeState],
  );

  const accept = useCallback(
    (final: LiveMicResult, settle: number, afterState: MicState = "done") => {
      if (acceptedRef.current) return;
      acceptedRef.current = true;
      latest.current.onFinal(final);
      if (settle <= 0) {
        changeState(afterState);
      } else {
        settleTimer.current = setTimeout(() => changeState(afterState), settle);
      }
    },
    [changeState],
  );

  const finish = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || finishingRef.current) return;
    finishingRef.current = true;
    try {
      const final = await session.stop();
      sessionRef.current = null;
      setLevel(0);
      if (final.transcript === "") {
        fail("no_speech");
        return;
      }
      const full: LiveMicResult = { ...final, speechModel: speechModelRef.current };
      setResult(full);
      setLiveText(final.transcript);
      changeState("transcript");
      if (latest.current.variant === "compact") {
        accept(full, 0, "idle");
      } else if (latest.current.stopOn === "first-turn") {
        accept(full, latest.current.settleMs ?? 700);
      }
    } catch {
      fail("stream_error");
    } finally {
      finishingRef.current = false;
    }
  }, [accept, changeState, fail]);

  const begin = useCallback(async () => {
    if (sessionRef.current || finishingRef.current) return;
    acceptedRef.current = false;
    setResult(null);
    setLiveText("");
    setErrorCode(null);
    setLevel(0);
    setElapsedMs(0);
    setConnecting(true);
    changeState("idle");

    const session = new StreamSession(
      {
        onLive: (text) => {
          setLiveText(text);
          latest.current.onLive?.(text);
        },
        onLevel: setLevel,
        onFinalTurn: () => {
          if (latest.current.stopOn === "first-turn") void finish();
        },
        onFatal: (code) => fail(code),
        onEvent: (type, detail) => latest.current.debug?.onEvent?.(type, detail),
      },
      latest.current.debug?.nativeSampleRate ?? false,
    );
    sessionRef.current = session;

    try {
      await session.start(async () => {
        try {
          const [config, minted] = await Promise.all([
            convex.query(api.levelCheck.getStreamConfig, {
              purpose: latest.current.purpose,
              ...(latest.current.goalId !== undefined ? { goalId: latest.current.goalId } : {}),
            }),
            convex.action(api.levelCheck.getStreamingToken, {}),
          ]);
          speechModelRef.current = config.connectionParams.speech_model;
          return {
            token: minted.token,
            websocketUrl: minted.websocketUrl,
            connectionParams: { ...config.connectionParams },
          };
        } catch (error) {
          throw new StreamError("token_failed", error instanceof Error ? error.message : String(error));
        }
      });
      if (sessionRef.current !== session) return; // stopped or unmounted while connecting
      latest.current.debug?.onConnection?.({
        speechModel: speechModelRef.current,
        sampleRate: session.contextSampleRate,
      });
      startedAtRef.current = Date.now();
      setConnecting(false);
      changeState("listening");
    } catch (error) {
      if (sessionRef.current !== session) return;
      fail(error instanceof StreamError ? error.code : "stream_error");
    }
  }, [changeState, convex, fail, finish]);

  // Timer + optional auto-stop.
  useEffect(() => {
    if (state !== "listening") return;
    const id = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      if (maxSeconds !== undefined && elapsed >= maxSeconds * 1000) void finish();
    }, 200);
    return () => clearInterval(id);
  }, [state, maxSeconds, finish]);

  // Unmount: release the mic and close the socket immediately.
  useEffect(() => {
    return () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
  }, []);

  function onMicClick() {
    if (props.disabled || connecting) return;
    if (state === "listening") void finish();
    else if (state === "idle" || state === "error" || (state === "transcript" && !acceptedRef.current)) {
      void begin();
    }
  }

  const listening = state === "listening";

  if (props.variant === "compact") {
    return (
      <div className="flex flex-col items-start gap-2">
        <button
          type="button"
          onClick={onMicClick}
          disabled={props.disabled || connecting}
          aria-pressed={listening}
          className={
            "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-base transition-colors disabled:cursor-default " +
            (listening
              ? "border-accent bg-accent/15 text-fg"
              : "border-line-strong bg-surface-2 text-fg hover:border-accent")
          }
        >
          {connecting ? (
            <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
          ) : listening ? (
            <span aria-hidden="true" className="size-3 animate-pulse rounded-full bg-accent" />
          ) : (
            <MicIcon size={20} />
          )}
          <span>
            {connecting
              ? t("mic.connecting")
              : listening
                ? t("mic.compactStop")
                : (props.compactLabel ?? t("mic.speakInstead"))}
          </span>
        </button>
        {state === "error" && errorCode ? (
          <p role="alert" className="text-base text-danger">
            {t(`mic.err.${errorCode}` as MessageKey)}
          </p>
        ) : null}
      </div>
    );
  }

  const showBox = (listening || state === "transcript") && liveText !== "";
  const showDoneButton = props.showDone ?? stopOn === "manual";
  const micDisabled = props.disabled || connecting || state === "done";

  const statusTitle: string | null = connecting
    ? t("mic.connecting")
    : state === "idle"
      ? (props.idleText ?? t("mic.tapToSpeak"))
      : state === "listening"
        ? (props.listeningText ?? t("mic.listening"))
        : state === "transcript"
          ? t("mic.recordAgain")
          : state === "done"
            ? (props.doneTitle ?? t("mic.done"))
            : null;
  const statusSub: string | null =
    state === "listening"
      ? (props.listeningSubText ?? t("mic.speakNow"))
      : state === "done"
        ? (props.doneText ?? null)
        : null;

  const micLabel = listening
    ? t("mic.aria.stop")
    : state === "transcript"
      ? t("mic.aria.again")
      : t("mic.aria.start");

  return (
    <div className="flex w-full flex-col items-center gap-5">
      <MicCircle state={state} connecting={connecting} level={level} label={micLabel} disabled={micDisabled} onClick={onMicClick} />

      {state === "error" && errorCode ? (
        <div role="alert" className="w-full rounded-2xl border border-danger/50 p-4 text-center">
          <p className="text-base text-danger">{t(`mic.err.${errorCode}` as MessageKey)}</p>
          <button
            type="button"
            onClick={() => void begin()}
            className="mt-3 h-11 rounded-xl border border-line-strong px-5 text-base font-semibold"
          >
            {t("mic.tryAgain")}
          </button>
        </div>
      ) : (
        <div className="text-center" aria-live="polite">
          {statusTitle ? <p className="text-base font-semibold">{statusTitle}</p> : null}
          {statusSub ? <p className="text-base text-muted">{statusSub}</p> : null}
        </div>
      )}

      {maxSeconds !== undefined && state !== "error" ? (
        <div className="w-full">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={maxSeconds}
            aria-valuenow={Math.min(maxSeconds, Math.floor(elapsedMs / 1000))}
            className="h-1.5 w-full overflow-hidden rounded-full bg-line"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${Math.min(100, (elapsedMs / (maxSeconds * 1000)) * 100)}%` }}
            />
          </div>
          <p className="mt-2 text-base text-muted">
            {formatTime(elapsedMs)} / {formatTime(maxSeconds * 1000)}
          </p>
        </div>
      ) : null}

      {showBox ? (
        <div className="w-full rounded-2xl border border-line bg-surface p-4">
          <div className="flex items-center gap-2 text-base text-muted">
            <WaveIcon />
            {props.transcriptLabel ? <span>{props.transcriptLabel}</span> : null}
          </div>
          <p className="mt-2 text-lg leading-snug break-words">{liveText}</p>
        </div>
      ) : null}

      {showDoneButton ? (
        <PrimaryButton
          type="button"
          className="disabled:bg-surface-2 disabled:text-muted disabled:opacity-100"
          disabled={state !== "transcript" || result === null}
          onClick={() => result && accept(result, 0)}
        >
          {t("mic.doneBtn")}
        </PrimaryButton>
      ) : null}
    </div>
  );
}

function MicCircle({
  state,
  connecting,
  level,
  label,
  disabled,
  onClick,
}: {
  state: MicState;
  connecting: boolean;
  level: number;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const listening = state === "listening";
  const done = state === "done";
  const ringed = state === "transcript";

  return (
    <div className="relative grid size-40 place-items-center">
      {listening ? (
        <>
          <span
            aria-hidden="true"
            className="absolute inset-2 rounded-full border border-accent/40 transition-transform duration-150"
            style={{ transform: `scale(${1 + level * 0.3})` }}
          />
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full border border-accent/20 transition-transform duration-150"
            style={{ transform: `scale(${1 + level * 0.15})` }}
          />
        </>
      ) : null}
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={listening}
        className={
          "relative grid size-28 place-items-center rounded-full transition-colors disabled:cursor-default " +
          (listening || done
            ? "bg-accent text-accent-ink shadow-[0_0_40px_rgba(47,230,213,0.35)]"
            : ringed
              ? "border-2 border-accent bg-surface text-accent"
              : "border-2 border-line-strong bg-surface text-muted hover:text-fg")
        }
      >
        {connecting ? (
          <span
            aria-hidden="true"
            className="size-10 animate-spin rounded-full border-4 border-line-strong border-t-accent"
          />
        ) : done ? (
          <CheckIcon />
        ) : (
          <MicIcon />
        )}
      </button>
    </div>
  );
}

function MicIcon({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 18v4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function WaveIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" className="text-accent" aria-hidden="true">
      <rect x="3" y="10" width="2.5" height="4" rx="1.25" />
      <rect x="7.5" y="6" width="2.5" height="12" rx="1.25" />
      <rect x="12" y="3" width="2.5" height="18" rx="1.25" />
      <rect x="16.5" y="8" width="2.5" height="8" rx="1.25" />
    </svg>
  );
}
