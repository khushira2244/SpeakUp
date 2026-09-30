"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";

/**
 * The caller's "en" partner profile, if any. "en" is the only target language
 * a user can realistically self-apply for — knownLanguageValidator is
 * en/hi/te while targetLanguageValidator (what a partner offers) is en/de,
 * so "en" is the only overlap a learner's own known languages can reach.
 */
export function usePartnerProfile() {
  const profiles = useQuery(api.partners.myPartnerProfiles, {});
  if (profiles === undefined) return { status: "loading" as const, profile: null };
  const profile = profiles.find((p) => p.targetLanguage === "en") ?? null;
  return { status: "ready" as const, profile };
}
