"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { BrandHeader, Screen, Spinner } from "@/components/ui";
import { useI18n } from "@/i18n/provider";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { DescribeStep, type WizardMinutes } from "@/components/rooms/describe-step";
import { WhenStep, type Slot } from "@/components/rooms/when-step";

type Step = "describe" | "when";

export default function NewRoomPage() {
  const router = useRouter();
  const { t } = useI18n();
  const signedIn = useAuthGuard();
  const words = useQuery(api.home.words, signedIn ? {} : "skip");

  const requestRoomNow = useMutation(api.rooms.requestRoomNow);
  const requestRoomLater = useMutation(api.rooms.requestRoomLater);

  const [step, setStep] = useState<Step>("describe");
  const [scenario, setScenario] = useState("");
  const [minutes, setMinutes] = useState<WizardMinutes>(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (words === undefined) {
    return (
      <Screen>
        <BrandHeader />
        <div className="mt-16 flex flex-col items-center gap-3 text-muted" role="status">
          <Spinner />
          <p className="text-base">{t("common.loading")}</p>
        </div>
      </Screen>
    );
  }
  if (words === null) {
    return (
      <Screen>
        <BrandHeader />
        <p className="mt-16 text-center text-base text-muted">{t("room.book.error")}</p>
      </Screen>
    );
  }

  async function submit(mode: "now" | "later", slot: Slot | null) {
    setBusy(true);
    setError(null);
    try {
      if (mode === "now") {
        const { bookingId } = await requestRoomNow({ scenario: scenario.trim(), minutes, targetLanguage: words!.targetLanguage });
        router.push(`/rooms/${bookingId}`);
      } else {
        if (slot === null) return;
        const { bookingId } = await requestRoomLater({
          scenario: scenario.trim(),
          minutes,
          targetLanguage: words!.targetLanguage,
          partnerProfileId: slot.partnerProfileId,
          startAt: slot.startAt,
        });
        router.push(`/rooms/${bookingId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("room.book.error"));
    } finally {
      setBusy(false);
    }
  }

  if (step === "describe") {
    return (
      <DescribeStep
        scenario={scenario}
        minutes={minutes}
        level={words.level}
        onChangeScenario={setScenario}
        onChangeMinutes={setMinutes}
        onBack={() => router.push("/rooms")}
        onContinue={() => setStep("when")}
      />
    );
  }

  return (
    <WhenStep
      targetLanguage={words.targetLanguage}
      minutes={minutes}
      level={words.level ?? "starting"}
      onBack={() => setStep("describe")}
      onContinue={(mode, slot) => void submit(mode, slot)}
      busy={busy}
      error={error}
    />
  );
}
