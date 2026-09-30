"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { useI18n } from "@/i18n/provider";
import { cx, PrimaryButton, Screen, BrandHeader } from "@/components/ui";
import { useAuthGuard } from "@/lib/use-auth-guard";

type Choice = "learner" | "partner" | "both";

const CHOICES: ReadonlyArray<{ value: Choice; titleKey: "mode.learner.title" | "mode.partner.title" | "mode.both.title"; bodyKey: "mode.learner.body" | "mode.partner.body" | "mode.both.body" }> = [
  { value: "learner", titleKey: "mode.learner.title", bodyKey: "mode.learner.body" },
  { value: "partner", titleKey: "mode.partner.title", bodyKey: "mode.partner.body" },
  { value: "both", titleKey: "mode.both.title", bodyKey: "mode.both.body" },
];

/** Shown once, right after signup: what the new account is for. */
export default function ModePage() {
  const router = useRouter();
  const { t } = useI18n();
  useAuthGuard();
  const setMode = useMutation(api.users.setMode);

  const [choice, setChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onContinue() {
    if (choice === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setMode({ mode: choice });
      router.replace(choice === "partner" ? "/partner/language" : "/intro");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mode.error"));
      setBusy(false);
    }
  }

  return (
    <Screen>
      <BrandHeader />

      <section className="mt-8">
        <h2 className="text-[28px] leading-tight font-bold">{t("mode.title")}</h2>
        <p className="mt-2 text-base text-muted">{t("mode.subtitle")}</p>

        <div role="radiogroup" aria-label={t("mode.title")} className="mt-6 flex flex-col gap-3">
          {CHOICES.map((c) => {
            const checked = choice === c.value;
            return (
              <label
                key={c.value}
                className={cx(
                  "flex cursor-pointer flex-col gap-1 rounded-2xl border px-4 py-4 text-left select-none transition-colors",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                  checked
                    ? "border-accent bg-accent/10 shadow-[0_0_0_1px_var(--color-accent)]"
                    : "border-line bg-surface hover:border-line-strong",
                )}
              >
                <input
                  type="radio"
                  name="mode"
                  value={c.value}
                  checked={checked}
                  onChange={() => setChoice(c.value)}
                  className="sr-only"
                />
                <span className="text-base font-semibold">{t(c.titleKey)}</span>
                <span className="text-base text-muted">{t(c.bodyKey)}</span>
              </label>
            );
          })}
        </div>

        {error ? (
          <p role="alert" className="mt-4 text-base text-danger">
            {error}
          </p>
        ) : null}
      </section>

      <div className="mt-auto pt-6">
        <PrimaryButton type="button" busy={busy} disabled={choice === null} onClick={() => void onContinue()}>
          {t("common.continue")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}
