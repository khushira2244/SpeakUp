"use client";

import { useParams } from "next/navigation";
import type { Id } from "@convex/_generated/dataModel";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { LabFlow } from "@/components/lab/flow";

export default function LabPage() {
  const params = useParams<{ goalId: string; dayNo: string }>();
  const signedIn = useAuthGuard();
  if (!signedIn) return null;

  const goalId = params.goalId as Id<"goals">;
  const dayNo = Number(params.dayNo);

  return <LabFlow goalId={goalId} dayNo={dayNo} />;
}
