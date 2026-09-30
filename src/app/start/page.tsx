"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { isSupportedLang } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, Screen, Spinner } from "@/components/ui";

// Where a signed-in user belongs: setup if they have no goal yet, otherwise on.
export default function StartPage() {
  const router = useRouter();
  const { t, lang, setLang } = useI18n();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useQuery(api.users.me, isAuthenticated ? {} : "skip");
  const goal = useQuery(api.goals.activeGoal, isAuthenticated ? {} : "skip");
  const pass = useQuery(api.passes.activePass, isAuthenticated ? {} : "skip");

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/auth");
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    if (me === undefined || goal === undefined || pass === undefined) return;
    if (me && isSupportedLang(me.primaryLanguage) && me.primaryLanguage !== lang) {
      setLang(me.primaryLanguage);
    }
    router.replace(goal ? (pass?.isActive ? "/home" : "/level-check") : "/learn");
  }, [me, goal, pass, lang, setLang, router]);

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
