"use client";

import type { Id } from "@convex/_generated/dataModel";
import { useI18n } from "@/i18n/provider";
import { PromptStep, WordStep } from "@/components/level-check/steps";
import { FailedView, IntroView, MicBlockedView, ProcessingView, ResultView } from "@/components/level-check/views";
import type { LevelResult } from "@/components/level-check/helpers";

const noop = () => undefined;

const MEANINGS: Record<string, { meaning: string; hint: string | null }> = {
  doctor: { meaning: "डॉक्टर", hint: "डॉक्टर" },
  pain: { meaning: "दर्द", hint: "पेन" },
  medicine: { meaning: "दवा", hint: "मेडिसिन" },
  fever: { meaning: "बुखार", hint: "फीवर" },
  headache: { meaning: "सिरदर्द", hint: "हेडेक" },
};

function sample(level: LevelResult["level"], lang: "en" | "hi"): LevelResult {
  const low = level === "starting";
  const summary =
    lang === "hi"
      ? low
        ? "आप कुछ आसान शब्द और छोटे वाक्य बोल सकते हैं। थोड़े अभ्यास से आप जल्द ही डॉक्टर से आत्मविश्वास से बात कर पाएँगे।"
        : "आप अपना परिचय दे सकते हैं और बुनियादी लक्षणों को समझा सकते हैं। लंबी बातचीत में अधिक आत्मविश्वास महसूस करने के लिए अभ्यास जारी रखें।"
      : low
        ? "You can say a few simple words and short sentences. With a little practice you will soon feel confident talking to a doctor."
        : "You can introduce yourself and explain basic symptoms. Keep practising to feel more confident in longer conversations.";
  const notYet = low
    ? ["doctor", "pain", "medicine", "fever", "headache", ...Array.from({ length: 30 }, (_, i) => `word${i}`)]
    : Array.from({ length: 19 }, (_, i) => `word${i}`);
  return {
    levelCheckId: "sample" as Id<"levelChecks">,
    goalId: "sample" as Id<"goals">,
    canUse: low ? ["hello", "thank you"] : Array.from({ length: 12 }, (_, i) => `known${i}`),
    practising: low ? ["yes", "no", "please"] : Array.from({ length: 9 }, (_, i) => `practising${i}`),
    notYet,
    grammar: [
      { name: "I have ___", status: low ? "practising" : "ok" },
      { name: "My ___ hurts", status: low ? "not_yet" : "practising" },
      { name: "Can I ___ ?", status: "not_yet" },
    ],
    speakingSummary: summary,
    level,
    knownCount: low ? 5 : 21,
    totalCount: 40,
    createdAt: 0,
  };
}

export function LevelCheckGallery({ view }: { view: string }) {
  const { lang } = useI18n();
  const l = lang === "hi" ? "hi" : "en";
  const common = { onBack: noop, onError: noop, onFinal: noop };

  switch (view) {
    case "intro":
      return <IntroView onStart={noop} busy={false} failed={false} onBack={noop} />;
    case "word":
      return <WordStep index={1} total={5} word="appointment" onSkip={noop} {...common} />;
    case "prompt":
      return (
        <PromptStep
          index={1}
          total={2}
          target="en"
          prompt={{ english: "Tell me about your family.", native: "अपने परिवार के बारे में बताइए।" }}
          {...common}
        />
      );
    case "prompt-own":
      return (
        <PromptStep
          index={1}
          total={2}
          target="en"
          previewLive="मेरे परिवार में चार लोग हैं।"
          prompt={{ english: "Tell me about your family.", native: "अपने परिवार के बारे में बताइए।" }}
          {...common}
        />
      );
    case "blocked":
      return <MicBlockedView onRetry={noop} />;
    case "processing":
      return <ProcessingView status="processing" onComplete={noop} />;
    case "failed":
      return <FailedView onRetry={noop} onStartOver={noop} busy={false} />;
    case "result":
    case "result-low":
      return (
        <ResultView
          goalType="doctor"
          goalLabel={l === "hi" ? "डॉक्टर से बात करना" : "Talk to a doctor"}
          result={sample(view === "result-low" ? "starting" : "basic", l)}
          meanings={MEANINGS}
          showDemoNote
          onContinue={noop}
        />
      );
    default:
      return <p className="p-6">Unknown view: {view}</p>;
  }
}
