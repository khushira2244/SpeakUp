"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@convex/_generated/api";
import { useI18n } from "@/i18n/provider";
import { ChoiceRow, PrimaryButton } from "@/components/ui";
import { SetupShell } from "@/components/setup-shell";
import { updateDraft, useSetupDraft, type TargetLang } from "@/lib/setup-draft";
import { useAuthGuard } from "@/lib/use-auth-guard";

const ALL_TARGETS: readonly TargetLang[] = ["en", "de"];

export default function LearnPage() {
  const router = useRouter();
  const { t, lang } = useI18n();
  const { signOut } = useAuthActions();
  const signedIn = useAuthGuard();
  const me = useQuery(api.users.me, signedIn ? {} : "skip");
  const updateProfile = useMutation(api.users.updateProfile);
  const draft = useSetupDraft();

  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const known = me === undefined ? null : (me?.knownLanguages ?? [lang]);
  // A learner can't learn the only language they already know.
  const options =
    known === null ? [] : ALL_TARGETS.filter((l) => !(known.length === 1 && known[0] === l));
  const choice: TargetLang | null =
    options.length === 1
      ? (options[0] ?? null)
      : draft.targetLanguage && options.includes(draft.targetLanguage)
        ? draft.targetLanguage
        : null;

  async function onContinue() {
    if (!choice || !me || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      if (me.targetLanguage !== choice) {
        await updateProfile({
          knownLanguages: me.knownLanguages ?? [lang],
          primaryLanguage: me.primaryLanguage ?? lang,
          targetLanguage: choice,
          gender: me.gender ?? "unspecified",
        });
      }
      updateDraft({ targetLanguage: choice });
      router.push("/goal");
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <SetupShell
      title={t("learn.title")}
      subtitle={t("learn.subtitle")}
      onBack={() => router.push("/intro")}
      footer={
        <div className="flex flex-col gap-3">
          {failed ? (
            <p role="alert" className="text-center text-base text-danger">
              {t("setup.saveFailed")}
            </p>
          ) : null}
          <PrimaryButton type="button" busy={busy} disabled={!choice || !me} onClick={() => void onContinue()}>
            {t("common.continue")}
          </PrimaryButton>
          <button
            type="button"
            onClick={() => void signOut()}
            className="h-11 text-base text-muted hover:text-fg"
          >
            {t("goal.logOut")}
          </button>
        </div>
      }
    >
      <div role="radiogroup" aria-label={t("learn.groupLabel")} className="flex flex-col gap-3">
        {options.map((l) => (
          <ChoiceRow
            key={l}
            name="target"
            value={l}
            checked={choice === l}
            onChange={() => updateDraft({ targetLanguage: l })}
          >
            {t(l === "en" ? "learn.en" : "learn.de")}
          </ChoiceRow>
        ))}
      </div>
    </SetupShell>
  );
}
