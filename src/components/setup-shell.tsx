"use client";

import type { ReactNode } from "react";
import { BackButton, BrandHeader, Screen } from "@/components/ui";

/** Common frame for the setup screens: back arrow, brand, title, content, footer. */
export function SetupShell({
  title,
  subtitle,
  onBack,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Screen>
      <div className="relative">
        <BackButton onClick={onBack} />
        <BrandHeader />
      </div>

      <section className="mt-8">
        <h2 className="text-[28px] leading-tight font-bold">{title}</h2>
        {subtitle ? <p className="mt-2 text-base text-muted">{subtitle}</p> : null}
        <div className="mt-6">{children}</div>
      </section>

      <div className="mt-auto pt-6">{footer}</div>
    </Screen>
  );
}
