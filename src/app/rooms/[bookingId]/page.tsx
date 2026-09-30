"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { BrandHeader, Screen, Spinner } from "@/components/ui";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { ScriptStep } from "@/components/rooms/script-step";
import { PayStep } from "@/components/rooms/pay-step";
import { FindingStep } from "@/components/rooms/finding-step";
import { NoPartnerStep } from "@/components/rooms/no-partner-step";

const LIVE_ROOM_STATUSES = new Set([
  "confirmed",
  "in_progress",
  "completed",
  "no_show_partner",
  "no_show_learner",
  "ended_violation",
  "cancelled",
]);

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

export default function RoomBookingStatusPage() {
  const params = useParams<{ bookingId: string }>();
  const bookingId = params.bookingId as Id<"roomBookings">;
  const signedIn = useAuthGuard();
  const router = useRouter();

  const detail = useQuery(api.rooms.roomBookingDetail, signedIn ? { bookingId } : "skip");
  const [reviewedScript, setReviewedScript] = useState(false);

  const shouldRedirect = detail !== undefined && LIVE_ROOM_STATUSES.has(detail.status);

  useEffect(() => {
    if (shouldRedirect) router.replace(`/room/${bookingId}`);
  }, [shouldRedirect, router, bookingId]);

  if (detail === undefined || shouldRedirect) return <Loading />;

  if (detail.script === null || !reviewedScript) {
    return (
      <ScriptStep
        bookingId={bookingId}
        lines={detail.script?.lines ?? null}
        onBack={() => router.push("/rooms")}
        onContinue={() => setReviewedScript(true)}
      />
    );
  }

  if (detail.status === "requested") {
    return <FindingStep bookingId={bookingId} since={detail.scheduledStartAt ?? Date.now()} />;
  }
  if (detail.status === "no_partner") {
    return <NoPartnerStep bookingId={bookingId} targetLanguage={detail.targetLanguage} minutes={detail.minutes} level={detail.learnerLevel} />;
  }
  // "matched" (later mode just booked, or a "now" request a partner just accepted)
  return (
    <PayStep
      bookingId={bookingId}
      scenario={detail.scenario}
      minutes={detail.minutes}
      mode={detail.mode}
      scheduledStartAt={detail.scheduledStartAt}
      onBack={() => router.push("/rooms")}
    />
  );
}
