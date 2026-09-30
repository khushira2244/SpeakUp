"use client";

/**
 * Learner-only: watches the transcript for "no learner speech after a partner
 * turn" and calls reportSilence after SILENCE_REPORT_MS. The server
 * independently re-validates real elapsed time before setting the stuck cue
 * (see convex/liveRoom.ts reportSilence) — this is only the client-side
 * trigger that decides WHEN to ask.
 *
 * Lives outside LiveRoomView (which stays purely presentational, driven only
 * by props, so /dev/room-preview can render it with mock data) and is called
 * directly from the room page, which already has real Convex access.
 */

import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { RoomRole } from "./types";

const SILENCE_REPORT_MS = 8_000;

export function useSilenceWatcher(bookingId: Id<"roomBookings">, role: RoomRole | null, active: boolean): void {
  const reportSilence = useMutation(api.liveRoom.reportSilence);
  const lastTurn = useQuery(api.liveRoom.recentTurns, active && role === "learner" ? { bookingId, limit: 1 } : "skip");
  const reportedForRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active || role !== "learner") return;
    const last = lastTurn?.[0];
    if (!last || last.role !== "partner" || reportedForRef.current === last.createdAt) return;
    const timer = setTimeout(() => {
      reportedForRef.current = last.createdAt;
      void reportSilence({ bookingId, seconds: SILENCE_REPORT_MS / 1000 }).catch(() => {});
    }, SILENCE_REPORT_MS);
    return () => clearTimeout(timer);
  }, [active, role, bookingId, lastTurn, reportSilence]);
}
