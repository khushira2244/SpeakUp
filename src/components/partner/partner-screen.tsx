"use client";

import type { ReactNode } from "react";
import { BackButton, BrandHeader, Screen } from "@/components/ui";
import { ModeSwitch } from "./mode-switch";

/** Common frame for every partner-mode screen: brand + back (optional) + the learner-mode switch. */
export function PartnerScreen({ onBack, children }: { onBack?: () => void; children: ReactNode }) {
  return (
    <Screen>
      <div className="relative">
        {onBack ? <BackButton onClick={onBack} /> : null}
        <BrandHeader tagline={false} />
      </div>
      <div className="mt-3 flex justify-end">
        <ModeSwitch mode="partner" />
      </div>
      {children}
    </Screen>
  );
}
