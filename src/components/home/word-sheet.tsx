"use client";

import { useState } from "react";
import type { Id } from "@convex/_generated/dataModel";
import { useI18n } from "@/i18n/provider";
import { PrimaryButton } from "@/components/ui";
import { ListenRow, Sheet } from "./sheet";
import { MAX_SAVED, type SaveResult, type WordEntry } from "./use-saved-words";

/** One word: meaning, how it sounds, Listen / Listen slowly, and Save to Pronunciation. */
export function WordSheet({
  entry,
  targetLang,
  savedId,
  onSave,
  onRemove,
  onClose,
}: {
  entry: WordEntry;
  targetLang: "en" | "de";
  savedId: Id<"savedWords"> | null;
  onSave: () => Promise<SaveResult>;
  onRemove: (id: Id<"savedWords">) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<"limit" | "error" | null>(null);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    if (savedId) {
      if (!(await onRemove(savedId))) setProblem("error");
    } else {
      const result = await onSave();
      if (result !== "ok") setProblem(result);
    }
    setBusy(false);
  }

  return (
    <Sheet title={entry.word} onClose={onClose}>
      {entry.pronunciationHint ? <p className="mt-2 text-[20px] text-muted">{entry.pronunciationHint}</p> : null}
      <p className="mt-3 text-[22px]">
        <span className="sr-only">{t("sheet.meaning")}: </span>
        {entry.meaning}
      </p>

      <ListenRow text={entry.word} lang={targetLang} />

      <div className="mt-5 flex flex-col gap-3">
        {problem ? (
          <p role="alert" className="text-base text-danger">
            {problem === "limit" ? t("sheet.limit", { n: MAX_SAVED }) : t("setup.saveFailed")}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy}
          aria-pressed={savedId !== null}
          className="flex h-14 items-center justify-center gap-2 rounded-2xl border border-line-strong text-[17px] font-semibold hover:border-accent disabled:opacity-60"
        >
          {savedId ? (
            <>
              <span className="text-accent" aria-hidden="true">
                ✓
              </span>
              {t("sheet.saved")}
            </>
          ) : (
            t("sheet.save")
          )}
        </button>
        {savedId ? (
          <button type="button" onClick={() => void toggle()} disabled={busy} className="h-11 text-base text-muted hover:text-fg">
            {t("sheet.remove")}
          </button>
        ) : null}
        <PrimaryButton type="button" onClick={onClose}>
          {t("sheet.close")}
        </PrimaryButton>
      </div>
    </Sheet>
  );
}
