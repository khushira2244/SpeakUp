"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { ChoiceRow, PrimaryButton } from "@/components/ui";
import { CalendarIcon, ClockIcon, TargetIcon } from "@/components/icons";
import { SetupShell } from "@/components/setup-shell";
import { PRESET_GOAL_TEXT } from "@/lib/goal-text";
import {
  MINUTES,
  clearDraft,
  updateDraft,
  useHydrated,
  useSetupDraft,
  type Minutes,
} from "@/lib/setup-draft";
import { useAuthGuard } from "@/lib/use-auth-guard";

// 15 minutes is pre-selected, as in the design: a middle option that is easy to change.
const DEFAULT_MINUTES: Minutes = 15;

export default function TimePage() {
  const router = useRouter();
  const { t } = useI18n();
  useAuthGuard();
  const setGoal = useMutation(api.goals.setGoal);
  const draft = useSetupDraft();
  const hydrated = useHydrated();

  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Once the goal is saved the draft is cleared on purpose: the guard below
  // must not read that as "arrived with steps missing".
  const [saved, setSaved] = useState(false);

  const minutes = draft.minutes ?? DEFAULT_MINUTES;
  const customText = draft.goalText.trim();

  // Arrived with earlier steps missing (reload, direct link): go back to them.
  useEffect(() => {
    if (!hydrated || saved) return;
    if (!draft.goalType || (draft.goalType === "custom" && customText === "")) router.replace("/goal");
    else if (!draft.deadline) router.replace("/deadline");
  }, [hydrated, saved, draft.goalType, draft.deadline, customText, router]);

  const goalLabel =
    draft.goalType === null
      ? "—"
      : draft.goalType === "custom"
        ? customText
        : t(`goal.type.${draft.goalType}` as MessageKey);
  const deadlineLabel = draft.deadline ? t(`deadline.${draft.deadline}` as MessageKey) : "—";

  async function onStart() {
    if (busy || !draft.goalType || !draft.deadline) return;
    setBusy(true);
    setFailed(false);
    try {
      await setGoal({
        goalType: draft.goalType,
        goalText: draft.goalType === "custom" ? customText : PRESET_GOAL_TEXT[draft.goalType],
        deadline: draft.deadline,
        minutesPerDay: minutes,
      });
      setSaved(true);
      clearDraft();
      router.push("/level-check");
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <SetupShell
      title={t("time.title")}
      subtitle={t("time.subtitle")}
      onBack={() => router.push("/deadline")}
      footer={
        <div className="flex flex-col gap-3">
          {failed ? (
            <p role="alert" className="text-center text-base text-danger">
              {t("setup.saveFailed")}
            </p>
          ) : null}
          <PrimaryButton type="button" busy={busy} onClick={() => void onStart()}>
            {busy ? t("time.saving") : t("time.start")}
          </PrimaryButton>
        </div>
      }
    >
      <div role="radiogroup" aria-label={t("time.groupLabel")} className="flex flex-col gap-3">
        {MINUTES.map((m) => (
          <ChoiceRow
            key={m}
            name="minutes"
            value={String(m)}
            checked={minutes === m}
            onChange={() => updateDraft({ minutes: m })}
          >
            <span className="flex flex-col">
              <span>{t(`time.${m}` as MessageKey)}</span>
              <span className="text-base text-muted">{t(`time.${m}.hint` as MessageKey)}</span>
            </span>
          </ChoiceRow>
        ))}
      </div>

      <section aria-labelledby="plan-summary" className="mt-6 rounded-2xl border border-line bg-surface p-4">
        <h3 id="plan-summary" className="text-base font-semibold">
          {t("summary.title")}
        </h3>
        <dl className="mt-3 grid gap-3 text-base">
          <SummaryRow icon={<TargetIcon />} label={t("summary.goal")} value={goalLabel} clamp />
          <SummaryRow icon={<CalendarIcon />} label={t("summary.deadline")} value={deadlineLabel} />
          <SummaryRow
            icon={<ClockIcon />}
            label={t("summary.time")}
            value={t("summary.perDay", { time: t(`time.${minutes}` as MessageKey) })}
          />
        </dl>
      </section>
    </SetupShell>
  );
}

function SummaryRow({
  icon,
  label,
  value,
  clamp,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  clamp?: boolean;
}) {
  return (
    <div className="grid grid-cols-[auto_6.5rem_1fr] items-start gap-3">
      <span className="pt-0.5 text-muted">{icon}</span>
      <dt className="text-muted">{label}</dt>
      <dd className={clamp ? "line-clamp-2 break-words" : ""}>{value}</dd>
    </div>
  );
}
