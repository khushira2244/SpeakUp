"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { cx } from "@/components/ui";
import { useSpeech, type SpeechLang } from "@/lib/speech";

/** A bottom sheet: covers the page, closes on Esc, on the dark area, or with the button. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/65"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="max-h-[92dvh] w-full max-w-[440px] overflow-y-auto rounded-t-3xl border border-line bg-surface px-5 pt-3 pb-6 outline-none"
      >
        <div aria-hidden="true" className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-line-strong" />
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-[26px] leading-tight font-bold break-words">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("sheet.close")}
            className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function SpeakerIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" />
      <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />
    </svg>
  );
}

/** "Listen" and "Listen slowly" with the phone voice; says so when the device has no voice for the language. */
export function ListenRow({ text, lang }: { text: string; lang: SpeechLang }) {
  const { t } = useI18n();
  const { speak, hasVoice, supported, ready } = useSpeech();
  const missing = !supported || (ready && !hasVoice(lang));

  return (
    <div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {([false, true] as const).map((slow) => (
          <button
            key={String(slow)}
            type="button"
            onClick={() => speak(text, lang, slow)}
            className="flex h-12 items-center justify-center gap-2 rounded-2xl border border-line-strong text-base font-semibold hover:border-accent"
          >
            <span className="text-accent">
              <SpeakerIcon />
            </span>
            {t(slow ? "sheet.listenSlow" : "sheet.listen")}
          </button>
        ))}
      </div>
      {missing ? (
        <p role="status" className="mt-3 text-base text-muted">
          {t("sheet.noVoice", { lang: t(`langname.${lang}` as MessageKey) })}
        </p>
      ) : null}
    </div>
  );
}

/** Small round speaker button used inside lists. Does not trigger the row it sits in. */
export function SpeakButton({ text, lang, label }: { text: string; lang: SpeechLang; label: string }) {
  const { speak } = useSpeech();
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        speak(text, lang);
      }}
      className={cx("grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-accent")}
    >
      <SpeakerIcon />
    </button>
  );
}
