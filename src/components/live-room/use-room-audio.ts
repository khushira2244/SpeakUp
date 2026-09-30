"use client";

/**
 * The live room's audio pipeline. Captures the microphone EXACTLY ONCE and
 * feeds the same MediaStream to three independent consumers:
 *   1. LiveKit (publishes it so the other participant hears it)
 *   2. AssemblyAI streaming, via StreamSession (refactored to accept an
 *      external MediaStream instead of calling getUserMedia itself)
 *   3. A local MediaRecorder (uploaded as the session recording on leave)
 *
 * `connect()` is imperative (called from the Lobby's "Join room" tap, or
 * automatically on a reload while still inside the join window — see
 * room-page.tsx), not driven by a prop, matching how LiveMic's begin()/
 * finish() work elsewhere in this codebase.
 */

import { useCallback, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { Room, RoomEvent, LocalAudioTrack, Track } from "livekit-client";
import type { Participant, RemoteTrack, RemoteTrackPublication, RemoteParticipant } from "livekit-client";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { StreamSession, StreamError, type LiveMicError, type FinalTurn } from "@/components/live-mic/stream-session";

export type RoomAudioPhase = "idle" | "connecting" | "live" | "ended" | "error";

export type RoomAudioApi = {
  phase: RoomAudioPhase;
  micLevel: number;
  liveText: string;
  remoteSpeaking: boolean;
  /** Non-null while LiveKit is mid-reconnect or AssemblyAI transcription has dropped and is retrying. */
  connectionIssue: "reconnecting" | "transcription_lost" | null;
  errorCode: LiveMicError | null;
  muted: boolean;
  connect: () => Promise<void>;
  /** Stops everything, uploads the recording, and returns once fully torn down. Safe to call more than once. */
  leave: () => Promise<void>;
  /** Disables the shared MediaStreamTrack itself — silences LiveKit, AssemblyAI, and the recording all at once. */
  toggleMute: () => void;
};

const RECORDER_TIMESLICE_MS = 1_000;
const AUDIO_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return AUDIO_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

export function useRoomAudio(args: { bookingId: Id<"roomBookings"> }): RoomAudioApi {
  const convex = useConvex();
  const { bookingId } = args;

  const [phase, setPhase] = useState<RoomAudioPhase>("idle");
  const [micLevel, setMicLevel] = useState(0);
  const [liveText, setLiveText] = useState("");
  const [remoteSpeaking, setRemoteSpeaking] = useState(false);
  const [connectionIssue, setConnectionIssue] = useState<"reconnecting" | "transcription_lost" | null>(null);
  const [errorCode, setErrorCode] = useState<LiveMicError | null>(null);
  const [muted, setMuted] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const roomRef = useRef<Room | null>(null);
  const sessionRef = useRef<StreamSession | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const leavingRef = useRef(false);
  const identityRef = useRef<string | null>(null);
  const reconnectAttemptedRef = useRef(false);

  const startTranscription = useCallback(
    async (stream: MediaStream) => {
      const session = new StreamSession({
        onLive: setLiveText,
        onLevel: setMicLevel,
        onFinalTurn: (turn: FinalTurn) => {
          void convex
            .mutation(api.liveRoom.saveRoomTurn, {
              bookingId,
              transcript: turn.transcript,
              words: turn.words.map((w) => ({ text: w.text, confidence: w.confidence ?? 0.7, start: w.start, end: w.end })),
              startMs: turn.startMs,
              endMs: turn.endMs,
            })
            .catch(() => {
              // A dropped saveRoomTurn call is not fatal to the room — the person can keep talking.
            });
        },
        onFatal: () => {
          if (leavingRef.current) return;
          // AssemblyAI dropped: try ONE reconnect on the same stream. Voice over
          // LiveKit keeps working either way — this only affects transcription/tracking.
          if (!reconnectAttemptedRef.current) {
            reconnectAttemptedRef.current = true;
            setConnectionIssue("reconnecting");
            void startTranscription(stream).catch(() => setConnectionIssue("transcription_lost"));
          } else {
            setConnectionIssue("transcription_lost");
          }
        },
      });
      sessionRef.current = session;
      await session.start(async () => {
        const config = await convex.action(api.liveRoom.roomStreamConfig, { bookingId });
        return {
          token: config.token,
          websocketUrl: config.websocketUrl,
          connectionParams: { ...config.connectionParams },
        };
      }, stream);
      reconnectAttemptedRef.current = false;
      setConnectionIssue((prev) => (prev === "reconnecting" ? null : prev));
    },
    [bookingId, convex],
  );

  const connect = useCallback(async () => {
    if (roomRef.current || phase === "connecting" || phase === "live") return;
    setPhase("connecting");
    setErrorCode(null);
    leavingRef.current = false;

    // 1. Capture the mic ONCE.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setErrorCode("mic_blocked");
      setPhase("error");
      return;
    }
    streamRef.current = stream;

    try {
      // 2. Mint the LiveKit token and connect + publish the SAME stream's audio track.
      const joined = await convex.action(api.liveRoom.joinRoom, { bookingId });
      identityRef.current = joined.identity;

      const room = new Room({ adaptiveStream: false, dynacast: false });
      roomRef.current = room;
      room.on(RoomEvent.Reconnecting, () => setConnectionIssue("reconnecting"));
      room.on(RoomEvent.Reconnected, () => setConnectionIssue(null));
      room.on(RoomEvent.Disconnected, () => {
        if (!leavingRef.current) setConnectionIssue("reconnecting");
      });
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        setRemoteSpeaking(speakers.some((p) => p.identity !== identityRef.current));
      });
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (track.kind !== Track.Kind.Audio || participant.identity === identityRef.current) return;
        const el = track.attach();
        el.autoplay = true;
        el.style.display = "none";
        document.body.appendChild(el);
      });

      await room.connect(joined.url, joined.token);
      const micTrack = new LocalAudioTrack(stream.getAudioTracks()[0]!, undefined, true);
      await room.localParticipant.publishTrack(micTrack, { source: Track.Source.Microphone });

      // 3. AssemblyAI streaming, on the SAME stream.
      await startTranscription(stream);

      // 4. Local recording, on the SAME stream.
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start(RECORDER_TIMESLICE_MS);
      recorderRef.current = recorder;

      setPhase("live");
    } catch (error) {
      setErrorCode(error instanceof StreamError ? error.code : "connection_failed");
      setPhase("error");
      await teardown();
    }
  }, [bookingId, convex, phase, startTranscription]);

  /** Stops everything and returns the recorded Blob (or null), leaving it to the caller to decide whether to upload it. */
  const teardown = useCallback(async (): Promise<Blob | null> => {
    leavingRef.current = true;
    sessionRef.current?.dispose();
    sessionRef.current = null;

    const recorder = recorderRef.current;
    recorderRef.current = null;
    let recordingBlob: Blob | null = null;
    if (recorder && recorder.state !== "inactive") {
      recordingBlob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }));
        recorder.stop();
      });
    }

    try {
      await roomRef.current?.disconnect(false);
    } catch {
      // already disconnected
    }
    roomRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    return recordingBlob;
  }, []);

  const toggleMute = useCallback(() => {
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }, []);

  const leave = useCallback(async () => {
    const blob = await teardown();
    setPhase("ended");
    if (!blob || blob.size === 0) return;
    try {
      const uploadUrl: string = await convex.mutation(api.liveRoom.generateRoomUploadUrl, { bookingId });
      const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      await convex.mutation(api.liveRoom.attachRoomRecording, { bookingId, storageId });
    } catch {
      // Recording upload is best-effort — the practice session itself already happened.
    }
  }, [bookingId, convex, teardown]);

  return { phase, micLevel, liveText, remoteSpeaking, connectionIssue, errorCode, muted, connect, leave, toggleMute };
}
