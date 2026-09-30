"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { LettersSection } from "@/components/home/pronunciation-tab";

function Preview() {
  const params = useSearchParams();
  const target = params.get("target") === "de" ? "de" : "en";
  const hint = params.get("hint") === "te" ? "te" : params.get("hint") === "en" ? "en" : "hi";
  return (
    <main className="mx-auto w-full max-w-[440px] px-5 py-6">
      <LettersSection target={target} hintLang={hint} />
    </main>
  );
}

export function LettersPreview() {
  return (
    <Suspense>
      <Preview />
    </Suspense>
  );
}
