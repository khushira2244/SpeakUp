"use client";

import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { useI18n } from "@/i18n/provider";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Centered mobile-width column. 390px on phones, ~440px max on desktop. */
export function Screen({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col px-5 pt-6 pb-6">
      {children}
    </main>
  );
}

export function BrandHeader() {
  const { t } = useI18n();
  return (
    <header className="text-center">
      <h1 className="text-[28px] leading-tight font-bold tracking-tight">
        <span className="text-accent">Speak</span>
        <span>Up</span>
      </h1>
      <p className="text-[13px] leading-tight text-muted">{t("brand.by")}</p>
      <p className="mt-2 text-base text-muted">{t("brand.tagline")}</p>
    </header>
  );
}

export function BackButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("common.back")}
      className="absolute top-0 left-0 grid size-11 place-items-center rounded-full text-fg hover:bg-surface-2"
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
    </button>
  );
}

type PrimaryButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
};

export function PrimaryButton({
  busy,
  className,
  children,
  disabled,
  ...rest
}: PrimaryButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-accent px-6 text-[17px] font-semibold text-accent-ink transition-opacity",
        "hover:brightness-105 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-5 animate-spin rounded-full border-2 border-accent-ink/30 border-t-accent-ink"
    />
  );
}

/** Full-width radio row (language list). The real radio input stays for a11y. */
export function ChoiceRow({
  name,
  value,
  checked,
  onChange,
  children,
  lang,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
  lang?: string;
}) {
  return (
    <label
      lang={lang}
      className={cx(
        "flex min-h-14 cursor-pointer items-center justify-between rounded-2xl border px-4 py-3 text-[17px] transition-colors",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        checked
          ? "border-accent bg-accent/10 shadow-[0_0_0_1px_var(--color-accent)]"
          : "border-line bg-surface hover:border-line-strong",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="sr-only"
      />
      <span>{children}</span>
      <span
        aria-hidden="true"
        className={cx(
          "grid size-6 place-items-center rounded-full border-2",
          checked ? "border-accent" : "border-line-strong",
        )}
      >
        {checked ? <span className="size-3 rounded-full bg-accent" /> : null}
      </span>
    </label>
  );
}

/** Compact pill radio (gender). */
export function ChoicePill({
  name,
  value,
  checked,
  onChange,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label
      className={cx(
        "flex min-h-12 cursor-pointer items-center rounded-full border px-4 text-base transition-colors",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        checked
          ? "border-accent bg-accent/15 text-fg"
          : "border-line bg-surface text-muted hover:border-line-strong",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="sr-only"
      />
      {children}
    </label>
  );
}

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  error?: string | null;
  hint?: string;
  trailing?: ReactNode;
};

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField({ label, error, hint, trailing, className, ...rest }, ref) {
    const id = useId();
    const errorId = `${id}-error`;
    const hintId = `${id}-hint`;
    const describedBy =
      [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") ||
      undefined;
    return (
      <div>
        <label htmlFor={id} className="mb-2 block text-base font-medium">
          {label}
        </label>
        <div className="relative">
          <input
            {...rest}
            ref={ref}
            id={id}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={cx(
              // 16px+ text: anything smaller makes iOS Safari zoom on focus.
              "h-14 w-full rounded-2xl border bg-surface px-4 text-base text-fg placeholder:text-placeholder",
              "focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40",
              error ? "border-danger" : "border-line",
              trailing ? "pr-14" : null,
              className,
            )}
          />
          {trailing ? (
            <div className="absolute inset-y-0 right-1 flex items-center">
              {trailing}
            </div>
          ) : null}
        </div>
        {hint && !error ? (
          <p id={hintId} className="mt-2 text-base text-muted">
            {hint}
          </p>
        ) : null}
        {error ? (
          <p id={errorId} role="alert" className="mt-2 text-base text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
