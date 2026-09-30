"use client";

import type { PartnerAlertToast } from "./use-partner-alerts";

/** Fixed-position stack of dismissible alert toasts — tap to dismiss early. */
export function ToastStack({ toasts, onDismiss }: { toasts: readonly PartnerAlertToast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-4 top-4 z-50 flex flex-col items-center gap-2">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => onDismiss(toast.id)}
          className="pointer-events-auto max-w-sm rounded-2xl border border-accent bg-surface px-4 py-3 text-left text-base font-semibold shadow-lg"
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
