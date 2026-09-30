"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useI18n } from "@/i18n/provider";
import { BackButton, BrandHeader, PrimaryButton, Screen, Spinner } from "@/components/ui";
import type { LiveMicError, LiveMicResult } from "@/components/live-mic/live-mic";
import { WordStep, PromptStep } from "@/components/level-check/steps";
import { MicBlockedView, ProcessingView, FailedView } from "@/components/level-check/views";

type Flow =
  | { phase: "words"; id: Id<"levelChecks">; wordIndex: number }
  | { phase: "prompts"; id: Id<"levelChecks">; promptIndex: number }
  | { phase: "submitted"; id: Id<"levelChecks"> };

const ADVANCE_MS = 1600;

function Loading() {
  const { t } = useI18n();
  return (
    <Screen>
      <BrandHeader tagline={false} />
      <div className="mt-16 flex flex-col items-center gap-3 text-muted" role="status">
        <span className="scale-150">
          <Spinner />
        </span>
        <p className="text-base">{t("common.loading")}</p>
      </div>
    </Screen>
  );
}

/** The partner speaking test — the same level-check mechanics as the learner flow, against a partner_test goal. */
export function PartnerTestFlow({ goalId, onBack, onDone }: { goalId: Id<"goals">; onBack: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const status = useQuery(api.partners.testGoalStatus, { goalId });
  const latest = useQuery(api.levelCheck.latestForGoal, { goalId });
  const startLevelCheck = useMutation(api.levelCheck.startLevelCheck);
  const saveAttempt = useMutation(api.levelCheck.saveAttempt);
  const finishLevelCheck = useMutation(api.levelCheck.finishLevelCheck);

  const [flow, setFlow] = useState<Flow | "intro" | null>(null);
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [micNonce, setMicNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [retrySave, setRetrySave] = useState<(() => void) | null>(null);
  const [retrying, setRetrying] = useState(false);

  const id = flow !== null && flow !== "intro" ? flow.id : null;
  const levelResult = useQuery(api.scoring.levelResult, id ? { levelCheckId: id } : "skip");

  // Decide where to begin once, from the most recent levelCheck against this goal (if any).
  useEffect(() => {
    if (flow !== null || latest === undefined) return;
    if (latest === null) setFlow("intro");
    else if (latest.status === "started") setFlow({ phase: "words", id: latest.levelCheckId, wordIndex: 0 });
    else setFlow({ phase: "submitted", id: latest.levelCheckId });
  }, [flow, latest]);

  const words = status?.levelCheckWords ?? [];
  const prompts = status?.levelCheckPrompts ?? [];
  const target = status?.targetLanguage ?? "en";

  const toWords = (r: LiveMicResult) =>
    r.words.map((w) => ({ text: w.text, confidence: w.confidence ?? 0.5, start: w.start, end: w.end }));

  const onMicError = useCallback((code: LiveMicError) => {
    if (code === "mic_blocked") setBlocked(true);
  }, []);

  function goToWord(index: number) {
    if (flow === null || flow === "intro" || flow.phase === "submitted") return;
    setRetrySave(null);
    setSaving(false);
    setFlow({ phase: "words", id: flow.id, wordIndex: index });
  }

  function goToPrompt(index: number) {
    if (flow === null || flow === "intro" || flow.phase === "submitted") return;
    setRetrySave(null);
    setSaving(false);
    setFlow({ phase: "prompts", id: flow.id, promptIndex: index });
  }

  async function onStart() {
    if (starting) return;
    setStarting(true);
    setStartFailed(false);
    try {
      const started = await startLevelCheck({ goalId });
      setFlow({ phase: "words", id: started.levelCheckId, wordIndex: 0 });
    } catch {
      setStartFailed(true);
    } finally {
      setStarting(false);
    }
  }

  async function saveWord(index: number, r: LiveMicResult) {
    if (flow === null || flow === "intro" || flow.phase !== "words") return;
    setSaving(true);
    setRetrySave(null);
    try {
      await saveAttempt({
        levelCheckId: flow.id,
        kind: "word",
        index,
        expected: words[index] ?? "",
        transcript: r.transcript,
        words: toWords(r),
        source: "streaming",
        languageDetected: r.languageCode ?? undefined,
      });
      setSaving(false);
      setTimeout(() => {
        if (index + 1 < words.length) goToWord(index + 1);
        else goToPrompt(0);
      }, ADVANCE_MS);
    } catch {
      setSaving(false);
      setRetrySave(() => () => void saveWord(index, r));
    }
  }

  async function savePrompt(index: number, r: LiveMicResult) {
    if (flow === null || flow === "intro" || flow.phase !== "prompts") return;
    const levelCheckId = flow.id;
    setSaving(true);
    setRetrySave(null);
    try {
      await saveAttempt({
        levelCheckId,
        kind: "prompt",
        index,
        expected: prompts[index]?.english ?? "",
        transcript: r.transcript,
        words: toWords(r),
        source: "streaming",
        languageDetected: r.languageCode ?? undefined,
      });
      if (index + 1 < prompts.length) {
        setSaving(false);
        goToPrompt(index + 1);
      } else {
        await finishLevelCheck({ levelCheckId });
        setSaving(false);
        setFlow({ phase: "submitted", id: levelCheckId });
      }
    } catch {
      setSaving(false);
      setRetrySave(() => () => void savePrompt(index, r));
    }
  }

  const notice = (
    <div className="mt-4 text-center text-base" aria-live="polite">
      {saving ? <p className="text-muted">{t("lc.saving")}</p> : null}
      {retrySave ? (
        <div role="alert">
          <p className="text-danger">{t("lc.saveFailed")}</p>
          <button type="button" onClick={retrySave} className="mt-2 h-11 rounded-xl border border-line-strong px-5 font-semibold">
            {t("mic.tryAgain")}
          </button>
        </div>
      ) : null}
    </div>
  );

  if (blocked) {
    return (
      <MicBlockedView
        onRetry={() => {
          setBlocked(false);
          setMicNonce((n) => n + 1);
        }}
      />
    );
  }

  if (status === undefined || latest === undefined || flow === null) return <Loading />;
  if (!status.targetsReady) {
    return (
      <Screen>
        <BrandHeader tagline={false} />
        <div className="mt-16 flex flex-col items-center gap-3 text-muted" role="status">
          <span className="scale-150">
            <Spinner />
          </span>
          <p className="text-base">{t("partner.test.preparing")}</p>
        </div>
      </Screen>
    );
  }

  if (flow === "intro") {
    return (
      <Screen>
        <div className="relative">
          <BackButton onClick={onBack} />
          <BrandHeader tagline={false} />
        </div>
        <section className="mt-8">
          <h2 className="text-[28px] leading-tight font-bold">{t("partner.test.intro.title")}</h2>
          <p className="mt-3 text-base text-muted">{t("partner.test.intro.body")}</p>
          <div className="mt-4 flex items-start gap-4 rounded-2xl border border-line bg-surface p-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
              </svg>
            </span>
            <p className="text-base text-muted">{t("lc.intro.mic.body")}</p>
          </div>
        </section>
        <div className="mt-auto flex flex-col gap-3 pt-8">
          {startFailed ? (
            <p role="alert" className="text-center text-base text-danger">
              {t("lc.intro.failed")}
            </p>
          ) : null}
          <PrimaryButton type="button" busy={starting} onClick={() => void onStart()}>
            {t("partner.become.start")}
          </PrimaryButton>
        </div>
      </Screen>
    );
  }

  if (flow.phase === "words") {
    const i = flow.wordIndex;
    return (
      <WordStep
        key={`w${i}-${micNonce}`}
        index={i}
        total={words.length}
        word={words[i] ?? ""}
        goalId={goalId}
        onFinal={(r) => void saveWord(i, r)}
        onSkip={() => (i + 1 < words.length ? goToWord(i + 1) : goToPrompt(0))}
        onBack={() => (i > 0 ? goToWord(i - 1) : setFlow("intro"))}
        onError={onMicError}
        footer={notice}
      />
    );
  }

  if (flow.phase === "prompts") {
    const i = flow.promptIndex;
    const prompt = prompts[i];
    return (
      <PromptStep
        key={`p${i}-${micNonce}`}
        index={i}
        total={prompts.length}
        prompt={{ english: prompt?.english ?? "", native: prompt?.native ?? "" }}
        target={target}
        goalId={goalId}
        onFinal={(r) => void savePrompt(i, r)}
        onBack={() => (i > 0 ? goToPrompt(i - 1) : goToWord(Math.max(0, words.length - 1)))}
        onError={onMicError}
        footer={notice}
      />
    );
  }

  // submitted: processing / failed / done
  if (levelResult?.status === "failed") {
    return (
      <FailedView
        busy={retrying}
        onRetry={async () => {
          setRetrying(true);
          try {
            await finishLevelCheck({ levelCheckId: flow.id });
          } finally {
            setRetrying(false);
          }
        }}
        onStartOver={() => setFlow("intro")}
      />
    );
  }
  return <ProcessingView status={levelResult?.status ?? "processing"} onComplete={onDone} />;
}
