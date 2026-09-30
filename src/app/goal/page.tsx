"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { cx, PrimaryButton } from "@/components/ui";
import { GoalIcon } from "@/components/icons";
import { SetupShell } from "@/components/setup-shell";
import { LiveMic } from "@/components/live-mic/live-mic";
import {
  GOAL_TYPES,
  MAX_GOAL_CHARS,
  updateDraft,
  useSetupDraft,
  type GoalType,
} from "@/lib/setup-draft";
import { useAuthGuard } from "@/lib/use-auth-guard";

const PRESETS = GOAL_TYPES.filter((g): g is Exclude<GoalType, "custom"> => g !== "custom");

function joinText(base: string, addition: string): string {
  return [base.trim(), addition.trim()].filter(Boolean).join(" ").slice(0, MAX_GOAL_CHARS);
}

export default function GoalPage() {
  const router = useRouter();
  const { t } = useI18n();
  useAuthGuard();
  const draft = useSetupDraft();
  const textRef = useRef<HTMLTextAreaElement>(null);

  // While the mic is on, the live words are shown in the box but only the
  // final transcript is saved into the draft.
  const [listening, setListening] = useState(false);
  const [live, setLive] = useState("");

  const custom = draft.goalType === "custom";
  const shown = listening && live ? joinText(draft.goalText, live) : draft.goalText;
  const canContinue =
    draft.goalType !== null && (!custom || draft.goalText.trim().length > 0) && !listening;

  function select(type: GoalType) {
    updateDraft({ goalType: type });
    if (type === "custom") setTimeout(() => textRef.current?.focus(), 0);
  }

  return (
    <SetupShell
      title={t("goal.title")}
      subtitle={t("goal.subtitle")}
      onBack={() => router.push("/learn")}
      footer={
        <PrimaryButton type="button" disabled={!canContinue} onClick={() => router.push("/deadline")}>
          {t("common.continue")}
        </PrimaryButton>
      }
    >
      <div role="radiogroup" aria-label={t("goal.groupLabel")} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          {PRESETS.map((type) => {
            const checked = draft.goalType === type;
            return (
              <label
                key={type}
                className={cx(
                  "flex min-h-16 cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 text-base leading-snug select-none transition-colors",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                  checked
                    ? "border-accent bg-accent/10 shadow-[0_0_0_1px_var(--color-accent)]"
                    : "border-line bg-surface hover:border-line-strong",
                )}
              >
                <input
                  type="radio"
                  name="goal"
                  value={type}
                  checked={checked}
                  onChange={() => select(type)}
                  className="sr-only"
                />
                <span className={cx("shrink-0", checked ? "text-accent" : "text-muted")}>
                  <GoalIcon type={type} />
                </span>
                <span>{t(`goal.type.${type}` as MessageKey)}</span>
              </label>
            );
          })}
        </div>

        <div
          className={cx(
            "rounded-2xl border transition-colors",
            custom
              ? "border-accent bg-accent/10 shadow-[0_0_0_1px_var(--color-accent)]"
              : "border-line bg-surface hover:border-line-strong",
          )}
        >
          <label
            className={cx(
              "flex min-h-16 cursor-pointer items-center gap-3 rounded-2xl px-4 py-3 text-base select-none",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
            )}
          >
            <input
              type="radio"
              name="goal"
              value="custom"
              checked={custom}
              onChange={() => select("custom")}
              className="sr-only"
            />
            <span className={cx("shrink-0", custom ? "text-accent" : "text-muted")}>
              <GoalIcon type="custom" />
            </span>
            <span className="flex-1">{t("goal.type.custom")}</span>
            <span
              aria-hidden="true"
              className={cx(
                "grid size-6 place-items-center rounded-full border-2",
                custom ? "border-accent" : "border-line-strong",
              )}
            >
              {custom ? <span className="size-3 rounded-full bg-accent" /> : null}
            </span>
          </label>

          {custom ? (
            <div className="px-4 pb-4">
              <textarea
                ref={textRef}
                aria-label={t("goal.customLabel")}
                placeholder={t("goal.customPlaceholder")}
                value={shown}
                readOnly={listening}
                maxLength={MAX_GOAL_CHARS}
                rows={3}
                onChange={(e) => updateDraft({ goalText: e.target.value })}
                className="field-sizing-content max-h-56 min-h-24 w-full resize-none rounded-xl border border-line bg-bg p-3 text-base text-fg placeholder:text-placeholder focus:border-accent focus:ring-2 focus:ring-accent/40 focus:outline-none"
              />
              <div className="mt-3 flex items-start justify-between gap-3">
                <LiveMic
                  variant="compact"
                  purpose="own"
                  maxSeconds={45}
                  onStateChange={(s) => {
                    setListening(s === "listening");
                    if (s !== "listening") setLive("");
                  }}
                  onLive={setLive}
                  onFinal={(r) => updateDraft({ goalText: joinText(draft.goalText, r.transcript) })}
                />
                <span className="pt-2 text-base text-muted">
                  {shown.length}/{MAX_GOAL_CHARS}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </SetupShell>
  );
}
