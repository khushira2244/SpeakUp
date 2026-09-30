"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, Screen, Spinner } from "@/components/ui";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { Lobby } from "@/components/live-room/lobby";
import { LiveRoomView } from "@/components/live-room/live-room-view";
import { SessionEndedScreen, type EndedReason } from "@/components/live-room/session-ended-screen";
import { useRoomAudio } from "@/components/live-room/use-room-audio";
import { useSilenceWatcher } from "@/components/live-room/use-silence-watcher";
import type { RoomStateDoc } from "@/components/live-room/types";

function endedReasonFor(status: NonNullable<RoomStateDoc["endedReason"]>): EndedReason {
  switch (status) {
    case "ended_violation":
      return "violation";
    case "completed":
      return "completed";
    case "no_show_partner":
    case "no_show_learner":
      return "no_show";
    case "cancelled":
      return "cancelled";
    default:
      return "completed";
  }
}

function Loading() {
  return (
    <Screen>
      <BrandHeader tagline={false} />
      <div className="mt-16 flex flex-col items-center gap-3 text-muted" role="status">
        <span className="scale-150">
          <Spinner />
        </span>
      </div>
    </Screen>
  );
}

export default function RoomPage() {
  const params = useParams<{ bookingId: string }>();
  const bookingId = params.bookingId as Id<"roomBookings">;
  const signedIn = useAuthGuard();
  const router = useRouter();
  const { t } = useI18n();

  const roomState = useQuery(api.liveRoom.roomState, signedIn ? { bookingId } : "skip");
  const script = useQuery(api.rooms.latestScript, signedIn ? { bookingId } : "skip");
  const reportUser = useMutation(api.liveRoom.reportUser);

  const audio = useRoomAudio({ bookingId });
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const autoRejoinedRef = useRef(false);
  const autoLeftRef = useRef(false);

  useSilenceWatcher(bookingId, roomState?.role ?? null, roomState?.status === "in_progress");

  // Page reload while the booking is already "in_progress" (we had joined before): rejoin automatically.
  useEffect(() => {
    if (!roomState || autoRejoinedRef.current) return;
    if (roomState.status === "in_progress" && audio.phase === "idle") {
      autoRejoinedRef.current = true;
      setJoining(true);
      void audio
        .connect()
        .catch(() => setJoinError(t("mic.err.connection_failed")))
        .finally(() => setJoining(false));
    }
  }, [roomState, audio, t]);

  // The server ended the room for us (violation / auto-end / no-show) while we were still connected: tear down locally.
  useEffect(() => {
    if (roomState?.endedReason && audio.phase === "live" && !autoLeftRef.current) {
      autoLeftRef.current = true;
      void audio.leave();
    }
  }, [roomState?.endedReason, audio]);

  async function handleJoin() {
    setJoining(true);
    setJoinError(null);
    try {
      await audio.connect();
    } catch {
      setJoinError(t("mic.err.connection_failed"));
    } finally {
      setJoining(false);
    }
  }

  async function handleReport(reason: string) {
    await reportUser({ bookingId, reason });
  }

  if (roomState === undefined || script === undefined) return <Loading />;

  const role = roomState.role;

  if (roomState.endedReason !== null) {
    return (
      <SessionEndedScreen
        reason={endedReasonFor(roomState.endedReason)}
        role={role}
        violatorRole={roomState.violatorRole}
        bookingId={bookingId}
        onReport={handleReport}
      />
    );
  }

  if (audio.phase === "ended") {
    return <SessionEndedScreen reason="left" role={role} violatorRole={null} bookingId={bookingId} onReport={handleReport} />;
  }

  const inRoom = audio.phase === "connecting" || audio.phase === "live" || audio.phase === "error";
  if (!inRoom) {
    return (
      <Lobby
        role={role}
        roomState={roomState}
        script={script}
        joining={joining}
        joinError={joinError}
        onJoin={() => void handleJoin()}
        onBack={() => router.push("/rooms")}
      />
    );
  }

  return (
    <LiveRoomView
      role={role}
      roomState={roomState}
      script={script}
      audio={audio}
      onLeave={() => void audio.leave()}
      onReport={handleReport}
    />
  );
}
