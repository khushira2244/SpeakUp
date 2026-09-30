"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useI18n } from "@/i18n/provider";
import { BackButton, BrandHeader, PrimaryButton, Screen } from "@/components/ui";
import { RazorpayCheckout, type CheckoutOutcome } from "@/components/pay/razorpay-checkout";

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function PayStep({
  bookingId,
  scenario,
  minutes,
  mode,
  scheduledStartAt,
  onBack,
}: {
  bookingId: Id<"roomBookings">;
  scenario: string;
  minutes: number;
  mode: "now" | "later";
  scheduledStartAt: number | null;
  onBack: () => void;
}) {
  const { t, lang } = useI18n();
  const pricing = useQuery(api.rooms.roomPricing, {});
  const price = pricing?.find((p) => p.mode === mode && p.minutes === minutes) ?? null;
  const [failed, setFailed] = useState(false);

  const timeLabel =
    mode === "now" || scheduledStartAt === null
      ? t("room.home.now")
      : new Intl.DateTimeFormat(lang === "hi" ? "hi-IN" : "en-GB", {
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(scheduledStartAt));

  function handleOutcome(outcome: CheckoutOutcome) {
    if (outcome.status === "failed") setFailed(true);
    else setFailed(false);
    // "success": roomBookingDetail's status flips to "confirmed" reactively once the webhook/
    // verifyPayment authorizes it, and the parent page redirects to /room/[bookingId] from there.
  }

  return (
    <Screen>
      <div className="relative">
        <BackButton onClick={onBack} />
        <BrandHeader />
      </div>

      <section className="mt-8">
        <h2 className="text-[28px] leading-tight font-bold">{t("room.book.pay.title")}</h2>

        <div className="mt-6 divide-y divide-line rounded-2xl border border-line bg-surface">
          <Row label={t("room.book.pay.topic")} value={scenario} />
          <Row label={t("room.book.pay.duration")} value={t("room.live.minSession", { n: minutes })} />
          <Row label={t("room.book.pay.time")} value={timeLabel} />
          <Row label={t("room.book.pay.price")} value={price ? usd(price.displayUsdCents) : "…"} bold />
        </div>
        <p className="mt-3 text-base text-muted">{t("room.book.pay.note")}</p>
      </section>

      <div className="mt-auto pt-6">
        <RazorpayCheckout purpose="room_booking" refId={bookingId} description={scenario} onOutcome={handleOutcome}>
          {({ pay, busy }) => (
            <div className="flex flex-col gap-3">
              {failed ? (
                <p role="alert" className="text-center text-base text-danger">
                  {t("pay.failed")}
                </p>
              ) : null}
              <PrimaryButton type="button" busy={busy} onClick={pay}>
                {busy ? t("pay.processing") : t("room.book.pay.payBtn")}
              </PrimaryButton>
            </div>
          )}
        </RazorpayCheckout>
      </div>
    </Screen>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="text-base text-muted">{label}</span>
      <span className={bold ? "text-[17px] font-bold" : "text-base font-semibold break-words text-right"}>{value}</span>
    </div>
  );
}
