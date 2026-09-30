"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { ChoiceRow, PrimaryButton } from "@/components/ui";
import { SetupShell } from "@/components/setup-shell";
import { DEADLINES, updateDraft, useHydrated, useSetupDraft, type Deadline } from "@/lib/setup-draft";
import { useAuthGuard } from "@/lib/use-auth-guard";

export default function DeadlinePage() {
  const router = useRouter();
  const { t } = useI18n();
  useAuthGuard();
  const draft = useSetupDraft();
  const hydrated = useHydrated();

  // Arrived without a goal (reload, direct link): go back to pick one.
  useEffect(() => {
    if (hydrated && !draft.goalType) router.replace("/goal");
  }, [hydrated, draft.goalType, router]);

  return (
    <SetupShell
      title={t("deadline.title")}
      subtitle={t("deadline.subtitle")}
      onBack={() => router.push("/goal")}
      footer={
        <PrimaryButton type="button" disabled={!draft.deadline} onClick={() => router.push("/time")}>
          {t("common.continue")}
        </PrimaryButton>
      }
    >
      <div role="radiogroup" aria-label={t("deadline.groupLabel")} className="flex flex-col gap-3">
        {DEADLINES.map((d: Deadline) => (
          <ChoiceRow
            key={d}
            name="deadline"
            value={d}
            checked={draft.deadline === d}
            onChange={() => updateDraft({ deadline: d })}
          >
            {t(`deadline.${d}` as MessageKey)}
          </ChoiceRow>
        ))}
      </div>
    </SetupShell>
  );
}
