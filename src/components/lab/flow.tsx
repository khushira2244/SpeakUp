"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, PrimaryButton, Screen, Spinner } from "@/components/ui";
import type { SpeechLang } from "@/lib/speech";
import { LearnStep, AttemptStep } from "./steps";
import { CorrectionStep, type CorrectionItem } from "./correction";
import { SpeakingStep, type SpeakingSentence } from "./speaking";
import { ResultStep } from "./result";
import type { Answer } from "./answer-picker";

type LabDoc = NonNullable<FunctionReturnType<typeof api.labs.lab>>;
type SubmitResult = FunctionReturnType<typeof api.labs.submit>;
type UnitsData = NonNullable<FunctionReturnType<typeof api.home.units>>;
type PlanDay = NonNullable<UnitsData["plan"]>["days"][number];

type Phase =
  | "loading"
  | "generating"
  | "failed"
  | "alreadyDone"
  | "learn"
  | "grammar"
  | "story"
  | "grading"
  | "correction"
  | "speaking"
  | "result"
  | "retrying";

function fillBlank(sentence: string, word: string): string {
  return sentence.replace("___", word);
}

export function LabFlow({ goalId, dayNo }: { goalId: Id<"goals">; dayNo: number }) {
  const { t } = useI18n();
  const router = useRouter();

  const units = useQuery(api.home.units, {});
  const words = useQuery(api.home.words, {});
  const labDoc = useQuery(api.labs.lab, { goalId, dayNo });
  const generateLabForDay = useAction(api.labs.generateLabForDay);
  const generateRetry = useAction(api.labs.generateRetry);
  const submit = useMutation(api.labs.submit);

  const [phase, setPhase] = useState<Phase>("loading");
  const [grammarAnswers, setGrammarAnswers] = useState<Array<Answer | null>>([]);
  const [storyAnswers, setStoryAnswers] = useState<Array<Answer | null>>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [submitError, setSubmitError] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const generationTriggeredRef = useRef(false);
  const outcomeCapturedRef = useRef(false);
  const submittingRef = useRef(false);

  // 1. Trigger generation once, if the lab doesn't exist yet.
  useEffect(() => {
    if (labDoc === undefined || labDoc !== null || generationTriggeredRef.current) return;
    generationTriggeredRef.current = true;
    setPhase("generating");
    void generateLabForDay({ goalId, dayNo }).catch(() => setPhase("failed"));
  }, [labDoc, goalId, dayNo, generateLabForDay]);

  // 1b. Submit once, when entering "grading" — a side effect, so it belongs in
  // an effect (not the render body, which can re-run without re-submitting anything).
  useEffect(() => {
    if (phase !== "grading" || submittingRef.current) return;
    submittingRef.current = true;
    void (async () => {
      try {
        const result = await submit({
          goalId,
          dayNo,
          grammarAnswers: grammarAnswers.map((a) => a ?? { index: -1 }),
          storyAnswers: storyAnswers.map((a) => a ?? { index: -1 }),
        });
        setSubmitResult(result);
        setStepIndex(0);
        setPhase("correction");
      } catch {
        setSubmitError(true);
      } finally {
        submittingRef.current = false;
      }
    })();
  }, [phase, goalId, dayNo, submit, grammarAnswers, storyAnswers]);

  // 2. Once ready, decide where to start — only the FIRST time (a live reactive
  // update from our own submit()/retry() must not re-trigger this and reset the flow).
  useEffect(() => {
    if (labDoc === undefined) return;
    if (labDoc?.generation === "failed") {
      setPhase((p) => (p === "retrying" ? "failed" : p === "loading" || p === "generating" ? "failed" : p));
      return;
    }
    if (labDoc?.generation !== "ready") return;

    if (phase === "retrying") {
      if (labDoc.outcome === "pending") {
        setGrammarAnswers(new Array(labDoc.grammar.length).fill(null));
        setStoryAnswers(new Array(labDoc.story.length).fill(null));
        setStepIndex(0);
        setSubmitResult(null);
        setPhase("learn");
      }
      return;
    }
    if (outcomeCapturedRef.current) return;
    outcomeCapturedRef.current = true;
    if (labDoc.outcome === "pending") {
      setGrammarAnswers(new Array(labDoc.grammar.length).fill(null));
      setStoryAnswers(new Array(labDoc.story.length).fill(null));
      setPhase("learn");
    } else {
      setPhase("alreadyDone");
    }
  }, [labDoc, phase]);

  if (units === undefined || words === undefined || labDoc === undefined) {
    return (
      <Screen>
        <BrandHeader tagline={false} />
        <div className="mt-16 flex flex-col items-center gap-3 text-muted" role="status">
          <span className="scale-150">
            <Spinner />
          </span>
        </div>
      </Screen>
    );
  }

  const targetLang: SpeechLang = (words?.targetLanguage ?? "en") as SpeechLang;
  const day: PlanDay | undefined = units?.plan?.days.find((d) => d.dayNo === dayNo);
  const conceptByName = new Map((units?.concepts ?? []).map((c) => [c.pattern.trim().toLowerCase(), c]));

  function backToUnits() {
    router.push("/home");
  }

  // --- Generation states -----------------------------------------------------
  if (phase === "generating" || phase === "loading") {
    return (
      <Screen>
        <BrandHeader tagline={false} />
        <div className="mt-16 flex flex-col items-center gap-3 text-muted" role="status">
          <Spinner />
          <p className="text-base">{t("lab.generating")}</p>
        </div>
      </Screen>
    );
  }
  if (phase === "failed") {
    return (
      <Screen>
        <BrandHeader tagline={false} />
        <div className="mt-16 flex flex-col items-center gap-3 text-center">
          <p role="alert" className="text-base font-semibold text-danger">
            {t("lab.failedTitle")}
          </p>
          <p className="text-base text-muted">{t("lab.failedBody")}</p>
          <button
            type="button"
            onClick={() => {
              generationTriggeredRef.current = false;
              setPhase("loading");
            }}
            className="mt-2 h-11 rounded-2xl border border-line-strong px-5 text-base font-semibold"
          >
            {t("lab.retryGenerate")}
          </button>
        </div>
      </Screen>
    );
  }

  if (labDoc === null || day === undefined) {
    // Should not normally happen once "ready" — a day mismatch or a still-settling query.
    return (
      <Screen>
        <BrandHeader tagline={false} />
        <div className="mt-16 flex flex-col items-center gap-3 text-muted" role="status">
          <Spinner />
        </div>
      </Screen>
    );
  }

  if (phase === "alreadyDone") {
    return (
      <ResultStep
        pass={labDoc.outcome === "passed"}
        correctCount={null}
        totalCount={labDoc.grammar.length + labDoc.story.length}
        retriesLeft={labDoc.retriesLeft}
        retrying={retrying}
        onRetry={() => void handleRetry()}
        onBack={backToUnits}
      />
    );
  }

  // --- Learn -------------------------------------------------------------
  if (phase === "learn") {
    const patterns = day.patterns
      .map((name) => conceptByName.get(name.trim().toLowerCase()))
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    return (
      <LearnStep
        words={day.words}
        patterns={patterns}
        targetLang={targetLang}
        onStart={() => setPhase(labDoc.grammar.length > 0 ? "grammar" : "story")}
        onBack={backToUnits}
      />
    );
  }

  // --- Grammar check -------------------------------------------------------
  // safeIndex is only a defensive clamp (never a substitute for a state update
  // during render) — onNext below is the sole place stepIndex advances, and it
  // always stays in range.
  if (phase === "grammar") {
    const safeIndex = Math.min(stepIndex, labDoc.grammar.length - 1);
    const q = labDoc.grammar[safeIndex]!;
    const isLast = safeIndex === labDoc.grammar.length - 1;
    return (
      <AttemptStep
        titleKey="lab.grammar.title"
        progressLabel={t("lab.grammar.progress", { n: safeIndex + 1, total: labDoc.grammar.length })}
        instructionKey="lab.grammar.instruction"
        index={safeIndex}
        total={labDoc.grammar.length}
        sentence={q.sentence}
        meaning={q.meaning}
        options={q.options}
        answer={grammarAnswers[safeIndex] ?? null}
        onAnswer={(a) => setGrammarAnswers((prev) => prev.map((x, i) => (i === safeIndex ? a : x)))}
        targetLang={targetLang}
        isLast={isLast && labDoc.story.length === 0}
        onNext={() => {
          if (isLast) {
            setPhase(labDoc.story.length > 0 ? "story" : "grading");
            setStepIndex(0);
          } else {
            setStepIndex((i) => i + 1);
          }
        }}
        onBack={backToUnits}
      />
    );
  }

  // --- Story -----------------------------------------------------------------
  if (phase === "story") {
    const safeIndex = Math.min(stepIndex, labDoc.story.length - 1);
    const b = labDoc.story[safeIndex]!;
    const isLast = safeIndex === labDoc.story.length - 1;
    return (
      <AttemptStep
        titleKey="lab.story.title"
        progressLabel={t("lab.story.progress", { n: safeIndex + 1, total: labDoc.story.length })}
        instructionKey="lab.story.instruction"
        index={safeIndex}
        total={labDoc.story.length}
        sentence={b.sentence}
        meaning={b.meaning}
        options={b.options}
        answer={storyAnswers[safeIndex] ?? null}
        onAnswer={(a) => setStoryAnswers((prev) => prev.map((x, i) => (i === safeIndex ? a : x)))}
        targetLang={targetLang}
        isLast={isLast}
        onNext={() => {
          if (isLast) {
            setPhase("grading");
          } else {
            setStepIndex((i) => i + 1);
          }
        }}
        onBack={backToUnits}
      />
    );
  }

  // --- Grading (submit) --------------------------------------------------
  // The first attempt is in the effect above (fires once on entering "grading");
  // retrySubmit below is only for a manual "try again" after a failed call.
  if (phase === "grading") {
    async function retrySubmit() {
      setSubmitError(false);
      submittingRef.current = true;
      try {
        const result = await submit({
          goalId,
          dayNo,
          grammarAnswers: grammarAnswers.map((a) => a ?? { index: -1 }),
          storyAnswers: storyAnswers.map((a) => a ?? { index: -1 }),
        });
        setSubmitResult(result);
        setStepIndex(0);
        setPhase("correction");
      } catch {
        setSubmitError(true);
      } finally {
        submittingRef.current = false;
      }
    }
    return (
      <Screen>
        <BrandHeader tagline={false} />
        <div className="mt-16 flex flex-col items-center gap-3 text-center text-muted" role="status">
          {submitError ? null : <Spinner />}
          {submitError ? (
            <>
              <p role="alert" className="text-base text-danger">
                {t("mic.err.stream_error")}
              </p>
              <button
                type="button"
                onClick={() => void retrySubmit()}
                className="mt-2 h-11 rounded-2xl border border-line-strong px-5 text-base font-semibold text-fg"
              >
                {t("mic.tryAgain")}
              </button>
            </>
          ) : null}
        </div>
      </Screen>
    );
  }

  // --- Correction ----------------------------------------------------------
  if (phase === "correction" && submitResult !== null) {
    const items: CorrectionItem[] = [
      ...labDoc.grammar.map((q, i) => ({
        key: `g${i}`,
        sentence: fillBlank(q.sentence, submitResult.grammarAnswerWords[i] ?? ""),
        meaning: q.meaning,
        correct: submitResult.grammarCorrect[i] ?? false,
      })),
      ...labDoc.story.map((b, i) => ({
        key: `s${i}`,
        sentence: fillBlank(b.sentence, submitResult.storyAnswerWords[i] ?? b.word),
        meaning: b.meaning,
        correct: submitResult.storyCorrect[i] ?? false,
      })),
    ];
    return (
      <CorrectionStep
        items={items}
        targetLang={targetLang}
        pass={submitResult.pass}
        correctCount={submitResult.correctCount}
        totalCount={submitResult.totalCount}
        onContinue={() => setPhase("speaking")}
        onBack={backToUnits}
      />
    );
  }

  // --- Optional speaking -----------------------------------------------------
  if (phase === "speaking" && submitResult !== null) {
    const sentences: SpeakingSentence[] = [
      ...labDoc.grammar.map((q, i) => ({
        key: `g${i}`,
        text: fillBlank(q.sentence, submitResult.grammarAnswerWords[i] ?? ""),
        meaning: q.meaning,
      })),
      ...labDoc.story.map((b, i) => ({
        key: `s${i}`,
        text: fillBlank(b.sentence, submitResult.storyAnswerWords[i] ?? b.word),
        meaning: b.meaning,
      })),
    ];
    return <SpeakingStep sentences={sentences} targetLang={targetLang} onContinue={() => setPhase("result")} onBack={backToUnits} />;
  }

  // --- Result --------------------------------------------------------------
  if (phase === "result" && submitResult !== null) {
    return (
      <ResultStep
        pass={submitResult.pass}
        correctCount={submitResult.correctCount}
        totalCount={submitResult.totalCount}
        retriesLeft={submitResult.retriesLeft}
        retrying={retrying}
        onRetry={() => void handleRetry()}
        onBack={backToUnits}
      />
    );
  }

  if (phase === "retrying") {
    return (
      <Screen>
        <BrandHeader tagline={false} />
        <div className="mt-16 flex flex-col items-center gap-3 text-muted" role="status">
          <Spinner />
          <p className="text-base">{t("lab.result.retrying")}</p>
        </div>
      </Screen>
    );
  }

  async function handleRetry() {
    setRetrying(true);
    try {
      await generateRetry({ goalId, dayNo });
      setPhase("retrying");
    } catch {
      setPhase("failed");
    } finally {
      setRetrying(false);
    }
  }

  return null;
}
