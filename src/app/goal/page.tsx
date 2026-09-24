"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@convex/_generated/api";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, Screen } from "@/components/ui";

// Placeholder: the real goal-setting screens are the next task.
export default function GoalPage() {
  const router = useRouter();
  const { t } = useI18n();
  const { signOut } = useAuthActions();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useQuery(api.users.me, isAuthenticated ? {} : "skip");

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/auth");
  }, [isLoading, isAuthenticated, router]);

  return (
    <Screen>
      <BrandHeader />

      <section className="mt-10">
        {me?.name ? (
          <p className="text-base text-muted">{t("goal.greeting", { name: me.name })}</p>
        ) : null}
        <h2 className="mt-2 text-[28px] leading-tight font-bold">
          {t("goal.placeholderTitle")}
        </h2>
        <p className="mt-3 text-base text-muted">{t("goal.placeholderBody")}</p>
      </section>

      <div className="mt-auto pt-8">
        <button
          type="button"
          onClick={() => {
            // The guard effect above sends the signed-out user to /auth.
            void signOut();
          }}
          className="h-14 w-full rounded-2xl border border-line-strong text-[17px] font-semibold"
        >
          {t("goal.logOut")}
        </button>
      </div>
    </Screen>
  );
}
