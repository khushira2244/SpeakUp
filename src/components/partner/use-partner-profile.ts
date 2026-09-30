"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";

/**
 * The caller's partner profile, if any. A user applies for exactly one
 * target language today (either through the old self-service "en"-only
 * `/partner` entry, or the new signup-time language question, which offers
 * en/de) — prefer an approved profile if somehow more than one exists, else
 * the first one on file.
 */
export function usePartnerProfile() {
  const profiles = useQuery(api.partners.myPartnerProfiles, {});
  if (profiles === undefined) return { status: "loading" as const, profile: null };
  const profile = profiles.find((p) => p.status === "approved") ?? profiles[0] ?? null;
  return { status: "ready" as const, profile };
}
