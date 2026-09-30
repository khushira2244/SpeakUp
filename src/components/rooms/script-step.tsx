"use client";

import { useState, type ReactNode } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useI18n } from "@/i18n/provider";
import { BackButton, BrandHeader, PrimaryButton, Screen, cx } from "@/components/ui";

export type ScriptLine = { role: "learner" | "partner"; text: string; meaning?: string; words: string[] };

function highlight(text: string, words: string[]): ReactNode {
  const real = words.filter((w) => w.trim().length > 0);
  if (real.length === 0) return text;
  const pattern = new RegExp(`(${real.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(pattern).map((part, i) =>
    real.some((w) => w.toLowerCase() === part.toLowerCase()) ? (
      <strong key={i} className="text-accent">
        {part}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export function ScriptStep({
  bookingId,
  lines,
  onBack,
  onContinue,
}: {
  bookingId: Id<"roomBookings">;
  lines: ScriptLine[] | null;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { t } = useI18n();
  const generateScript = useAction(api.rooms.generateScript);
  const editScript = useMutation(api.rooms.editScript);

  const [drafting, setDrafting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Array<{ role: "learner" | "partner"; text: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDraft() {
    setDrafting(true);
    setError(null);
    try {
      await generateScript({ bookingId });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("room.book.error"));
    } finally {
      setDrafting(false);
    }
  }

  function startEdit() {
    setDraft((lines ?? []).map((l) => ({ role: l.role, text: l.text })));
    setEditing(true);
  }

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      await editScript({ bookingId, lines: draft });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("room.book.error"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen>
      <div className="relative">
        <BackButton onClick={onBack} />
        <BrandHeader />
      </div>

      <section className="mt-8">
        <h2 className="text-[28px] leading-tight font-bold">{t("room.book.script.title")}</h2>
        <p className="mt-2 text-base text-muted">{t("room.book.script.subtitle")}</p>

        <div className="mt-6">
          {lines === null ? (
            <div className="flex flex-col items-center gap-4 rounded-2xl border border-line bg-surface p-6 text-center">
              <p className="text-base text-muted">{t("room.book.script.empty")}</p>
              <PrimaryButton type="button" busy={drafting} onClick={() => void onDraft()}>
                {drafting ? t("room.book.script.drafting") : t("room.book.script.draft")}
              </PrimaryButton>
            </div>
          ) : editing ? (
            <div className="flex flex-col gap-3">
              {draft.map((l, i) => (
                <div key={i}>
                  <p className="mb-1 text-base font-semibold">
                    {t(l.role === "learner" ? "room.live.learnerRole" : "room.live.partnerRole")}
                  </p>
                  <textarea
                    value={l.text}
                    onChange={(e) =>
                      setDraft((prev) => prev.map((row, j) => (j === i ? { ...row, text: e.target.value } : row)))
                    }
                    rows={2}
                    maxLength={300}
                    className="w-full rounded-2xl border border-line bg-surface p-3 text-base text-fg focus:border-accent focus:outline-none"
                  />
                </div>
              ))}
              <div className="mt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="h-12 flex-1 rounded-2xl border border-line-strong text-base font-semibold"
                >
                  {t("room.book.script.cancelEdit")}
                </button>
                <PrimaryButton type="button" className="flex-1" busy={saving} onClick={() => void onSave()}>
                  {t("room.book.script.save")}
                </PrimaryButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {lines.map((l, i) => (
                <div key={i} className={cx("flex", l.role === "learner" ? "justify-start" : "justify-end")}>
                  <div
                    className={cx(
                      "max-w-[85%] rounded-2xl px-4 py-3",
                      l.role === "learner" ? "border border-line bg-surface" : "bg-accent/15",
                    )}
                  >
                    <p className="text-[13px] font-semibold text-muted">
                      {t(l.role === "learner" ? "room.live.learnerRole" : "room.live.partnerRole")}
                    </p>
                    <p className="mt-0.5 text-base leading-snug break-words">{highlight(l.text, l.words)}</p>
                    {l.meaning ? <p className="mt-1 text-[14px] break-words text-muted italic">({l.meaning})</p> : null}
                  </div>
                </div>
              ))}
              <div className="mt-2 flex gap-3">
                <button
                  type="button"
                  onClick={startEdit}
                  className="h-12 flex-1 rounded-2xl border border-line-strong text-base font-semibold"
                >
                  {t("room.book.script.edit")}
                </button>
              </div>
            </div>
          )}
          {error ? (
            <p role="alert" className="mt-3 text-center text-base text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </section>

      {lines !== null && !editing ? (
        <div className="mt-auto pt-6">
          <PrimaryButton type="button" onClick={onContinue}>
            {t("common.continue")}
          </PrimaryButton>
        </div>
      ) : null}
    </Screen>
  );
}
