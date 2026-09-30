"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { isSupportedLang } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, Screen, Spinner } from "@/components/ui";

// Where a signed-in user belongs: partner mode goes straight into the
// partner flow (no goal/level-check/pass involved); learner/both fall
// through to the original setup-if-no-goal-yet dispatch.
export default function StartPage() {
  const router = useRouter();
  const { t, lang, setLang } = useI18n();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useQuery(api.users.me, isAuthenticated ? {} : "skip");
  const isPartnerMode = me?.mode === "partner";
  const goal = useQuery(api.goals.activeGoal, isAuthenticated && !isPartnerMode ? {} : "skip");
  const pass = useQuery(api.passes.activePass, isAuthenticated && !isPartnerMode ? {} : "skip");
  const partnerProfiles = useQuery(api.partners.myPartnerProfiles, isAuthenticated && isPartnerMode ? {} : "skip");

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/auth");
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    if (me === undefined) return;
    if (me && isSupportedLang(me.primaryLanguage) && me.primaryLanguage !== lang) {
      setLang(me.primaryLanguage);
    }
    if (isPartnerMode) {
      if (partnerProfiles === undefined) return;
      // Applied already: let /partner route on to test/setup by status. Never applied
      // (e.g. they left mid-signup): back to the language question.
      router.replace(partnerProfiles.length === 0 ? "/partner/language" : "/partner");
      return;
    }
    if (goal === undefined || pass === undefined) return;
    router.replace(goal ? (pass?.isActive ? "/home" : "/level-check") : "/learn");
  }, [me, isPartnerMode, goal, pass, partnerProfiles, lang, setLang, router]);

  return (
    <Screen>
      <BrandHeader />
      <div className="mt-16 flex flex-col items-center gap-3 text-muted" role="status">
        <span className="scale-150">
          <Spinner />
        </span>
        <p className="text-base">{t("common.loading")}</p>
      </div>
    </Screen>
  );
}
