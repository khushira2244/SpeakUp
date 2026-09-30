"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, ChoiceRow, PrimaryButton, Screen } from "@/components/ui";
import { SetupShell } from "@/components/setup-shell";
import { addDays, DEFAULT_PASS, DEMO_MODE, PASSES, type PassId } from "@/lib/payments";
import { RazorpayCheckout, type CheckoutOutcome } from "@/components/pay/razorpay-checkout";
import { useAuthGuard } from "@/lib/use-auth-guard";

type Step = "choose" | "confirm" | "unlocked";

const INCLUDED: readonly MessageKey[] = ["pay.inc1", "pay.inc2", "pay.inc3", "pay.inc4", "pay.inc5"];

export default function PayPage() {
  const router = useRouter();
  const { t, lang } = useI18n();
  useAuthGuard();
  const startDemoPass = useMutation(api.passes.startDemoPass);
  // Reactive: once verifyPayment (or the webhook) captures the payment, the server grants the
  // pass and this query updates on its own — the "unlocked" screen's dates come from here.
  const activePass = useQuery(api.passes.activePass, {});

  const [step, setStep] = useState<Step>("choose");
  const [passId, setPassId] = useState<PassId>(DEFAULT_PASS);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [purchasedPassId, setPurchasedPassId] = useState<PassId | null>(null);

  const pass = PASSES.find((p) => p.id === passId) ?? PASSES[0]!;
  const passName = (id: PassId) => t(id === "week" ? "pay.week" : "pay.month");

  function handleOutcome(outcome: CheckoutOutcome) {
    if (outcome.status === "success") {
      setFailed(false);
      setPurchasedPassId(passId);
      setStep("unlocked");
    } else if (outcome.status === "failed") {
      setFailed(true);
    }
    // "cancelled": the learner just closed the checkout — stay put, no error shown.
  }

  async function onConfirmDemo() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await startDemoPass({ passId });
      setPurchasedPassId(passId);
      setStep("unlocked");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (step === "unlocked" && purchasedPassId) {
    // activePass reflects the just-granted pass almost immediately (Convex reactivity); a same-day
    // fallback keeps the date sensible for the one paint before it does.
    const endsAt =
      activePass?.isActive && activePass.passId === purchasedPassId
        ? new Date(activePass.endsAt)
        : addDays(new Date(), PASSES.find((p) => p.id === purchasedPassId)?.days ?? 0);
    const date = new Intl.DateTimeFormat(lang === "hi" ? "hi-IN" : "en-GB", {
      day: "numeric",
      month: "long",
    }).format(endsAt);
    return (
      <Screen>
        <BrandHeader />
        <div className="mt-16 flex flex-1 flex-col items-center text-center">
          <div className="grid size-32 place-items-center rounded-full bg-accent/15 shadow-[0_0_60px_rgba(47,230,213,0.25)]">
            <div className="grid size-24 place-items-center rounded-full bg-accent text-accent-ink">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </div>
          </div>
          <h2 className="mt-8 text-[28px] leading-tight font-bold">{t("pay.unlockedTitle")}</h2>
          <p className="mt-3 text-base text-muted">
            {t("pay.unlockedBody", { pass: passName(purchasedPassId), date })}
          </p>
        </div>
        <div className="pt-6">
          <PrimaryButton type="button" onClick={() => router.replace("/home")}>
            {t("pay.goHome")}
          </PrimaryButton>
        </div>
      </Screen>
    );
  }

  if (step === "confirm") {
    return (
      <SetupShell
        title={t("pay.confirmTitle")}
        onBack={() => {
          setFailed(false);
          setStep("choose");
        }}
        footer={
          DEMO_MODE ? (
            <div className="flex flex-col gap-3">
              {failed ? (
                <p role="alert" className="text-center text-base text-danger">
                  {t("pay.failed")}
                </p>
              ) : null}
              <PrimaryButton type="button" busy={busy} onClick={() => void onConfirmDemo()}>
                {busy ? t("pay.processing") : t("pay.confirmBtn")}
              </PrimaryButton>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setFailed(false);
                  setStep("choose");
                }}
                className="h-11 text-base text-muted hover:text-fg disabled:opacity-60"
              >
                {t("common.back")}
              </button>
            </div>
          ) : (
            <RazorpayCheckout purpose="pass" refId={passId} description={`SpeakUp — ${passName(passId)} pass`} onOutcome={handleOutcome}>
              {({ pay, busy: checkoutBusy }) => (
                <div className="flex flex-col gap-3">
                  {failed ? (
                    <p role="alert" className="text-center text-base text-danger">
                      {t("pay.failed")}
                    </p>
                  ) : null}
                  <PrimaryButton type="button" busy={checkoutBusy} onClick={pay}>
                    {checkoutBusy ? t("pay.processing") : t("pay.confirmBtn")}
                  </PrimaryButton>
                  <button
                    type="button"
                    disabled={checkoutBusy}
                    onClick={() => {
                      setFailed(false);
                      setStep("choose");
                    }}
                    className="h-11 text-base text-muted hover:text-fg disabled:opacity-60"
                  >
                    {t("common.back")}
                  </button>
                </div>
              )}
            </RazorpayCheckout>
          )
        }
      >
        <section className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-base font-semibold">{passName(pass.id)}</p>
          <p className="mt-1 text-[28px] leading-tight font-bold">{pass.price}</p>
          <p className="text-base text-muted">{t("pay.startsToday")}</p>
          {DEMO_MODE ? (
            <div className="mt-4 flex items-center gap-3 border-t border-line pt-4">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted" aria-hidden="true">
                <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
                <path d="M2.5 10h19" />
              </svg>
              <div>
                <span className="inline-block rounded-full bg-accent/15 px-2.5 py-0.5 text-[14px] text-accent">
                  {t("pay.demoBadge")}
                </span>
                <p className="mt-1 text-base text-muted">{t("pay.demoNote")}</p>
              </div>
            </div>
          ) : null}
        </section>
      </SetupShell>
    );
  }

  return (
    <SetupShell
      title={t("pay.title")}
      subtitle={t("pay.subtitle")}
      onBack={() => router.back()}
      footer={
        <PrimaryButton type="button" onClick={() => setStep("confirm")}>
          {t("common.continue")}
        </PrimaryButton>
      }
    >
      {DEMO_MODE ? (
        <div className="-mt-3 mb-4 flex justify-end">
          <span className="rounded-full border border-line-strong px-3 py-1 text-[14px] text-muted">
            {t("pay.demoBadge")}
          </span>
        </div>
      ) : null}

      <div role="radiogroup" aria-label={t("pay.groupLabel")} className="flex flex-col gap-3">
        {PASSES.map((p) => (
          <ChoiceRow
            key={p.id}
            name="pass"
            value={p.id}
            checked={passId === p.id}
            onChange={() => setPassId(p.id)}
          >
            <span className="flex flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{passName(p.id)}</span>
                <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-[14px] text-accent">
                  {t(p.id === "week" ? "pay.tagTry" : "pay.tagBest")}
                </span>
              </span>
              <span className="text-[24px] leading-tight font-bold">{p.price}</span>
              <span className="text-base text-muted">{t("pay.perDay", { price: p.perDay })}</span>
            </span>
          </ChoiceRow>
        ))}
      </div>

      <section aria-labelledby="pay-included" className="mt-4 rounded-2xl border border-line bg-surface p-4">
        <h3 id="pay-included" className="text-base font-semibold">
          {t("pay.includedTitle")}
        </h3>
        <ul className="mt-3 grid gap-3">
          {INCLUDED.map((key) => (
            <li key={key} className="flex items-start gap-3 text-base">
              <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent text-accent-ink" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              </span>
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
      </section>
    </SetupShell>
  );
}
