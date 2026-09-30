"use client";

import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, PrimaryButton, Screen, Spinner } from "@/components/ui";
import type { LiveMicError, LiveMicResult } from "@/components/live-mic/live-mic";
import { DEMO_MODE } from "@/lib/payments";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { clearSnapshot, loadSnapshot, saveSnapshot } from "./helpers";
import { PromptStep, WordStep } from "./steps";
import { FailedView, IntroView, MicBlockedView, ProcessingView, ResultView } from "./views";

type Flow =
  | { phase: "intro" }
  | { phase: "words"; id: Id<"levelChecks">; wordIndex: number }
  | { phase: "prompts"; id: Id<"levelChecks">; promptIndex: number }
  | { phase: "submitted"; id: Id<"levelChecks"> }
  | { phase: "result"; id: Id<"levelChecks"> };

/** How long "Got it" stays on screen before the next word appears. */
const ADVANCE_MS = 1600;

function Loading({ testId, text }: { testId?: string; text: string }) {
  return (
    <Screen>
      <BrandHeader />
      <div className="mt-16 flex flex-col items-center gap-3 text-muted" role="status">
        <span className="scale-150">
          <Spinner />
        </span>
        <p data-testid={testId} className="text-base">
          {text}
        </p>
      </div>
    </Screen>
  );
}

function LevelCheckFlowInner() {
  const router = useRouter();
  const { t } = useI18n();
  const signedIn = useAuthGuard();

  const goal = useQuery(api.goals.activeGoal, signedIn ? {} : "skip");
  const counts = useQuery(api.home.progressCounts, signedIn ? {} : "skip");
  const pass = useQuery(api.passes.activePass, signedIn ? {} : "skip");
  const startLevelCheck = useMutation(api.levelCheck.startLevelCheck);
  const saveAttempt = useMutation(api.levelCheck.saveAttempt);
  const finishLevelCheck = useMutation(api.levelCheck.finishLevelCheck);

  const [flow, setFlow] = useState<Flow | null>(null);
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [micNonce, setMicNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [retrySave, setRetrySave] = useState<(() => void) | null>(null);
  const [retrying, setRetrying] = useState(false);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const id = flow && flow.phase !== "intro" ? flow.id : null;
  const levelResult = useQuery(api.scoring.levelResult, id ? { levelCheckId: id } : "skip");

  // Decide where to begin once, when the goal and any earlier result are known.
  useEffect(() => {
    if (flow !== null || goal === undefined || counts === undefined || pass === undefined) return;
    if (goal === null) {
      router.replace("/learn");
      return;
    }
    if (!goal.targetsReady) return;

    // ?retake=1 forces a fresh check (used by tests and support).
    const retake = new URLSearchParams(window.location.search).has("retake");
    if (retake) {
      clearSnapshot();
      // Used up: a later reload must resume the check, not restart it.
      window.history.replaceState(null, "", window.location.pathname);
    }
    const snap = retake ? null : loadSnapshot();
    if (snap && snap.goalId === goal._id) {
      const lastWord = Math.max(0, goal.targets ? goal.targets.levelCheckWords.length - 1 : 0);
      const lastPrompt = Math.max(0, goal.targets ? goal.targets.levelCheckPrompts.length - 1 : 0);
      const levelCheckId = snap.levelCheckId as Id<"levelChecks">;
      if (snap.phase === "words") setFlow({ phase: "words", id: levelCheckId, wordIndex: Math.min(snap.wordIndex, lastWord) });
      else if (snap.phase === "prompts") setFlow({ phase: "prompts", id: levelCheckId, promptIndex: Math.min(snap.promptIndex, lastPrompt) });
      else setFlow({ phase: "submitted", id: levelCheckId });
    } else if (counts && !retake) {
      // Already paid: the result is behind them and Home is next.
      if (pass?.isActive) router.replace("/home");
      else setFlow({ phase: "result", id: counts.levelCheckId });
    } else {
      setFlow({ phase: "intro" });
    }
  }, [flow, goal, counts, pass, router]);

  // Remember progress so a reload does not restart the check.
  useEffect(() => {
    if (!flow || !goal) return;
    if (flow.phase === "intro" || flow.phase === "result") {
      clearSnapshot();
      return;
    }
    saveSnapshot({
      goalId: goal._id,
      levelCheckId: flow.id,
      phase: flow.phase,
      wordIndex: flow.phase === "words" ? flow.wordIndex : 0,
      promptIndex: flow.phase === "prompts" ? flow.promptIndex : 0,
    });
  }, [flow, goal]);

  // Resumed into a step, but the check has already moved on (another tab, or scoring started).
  useEffect(() => {
    if (!flow || (flow.phase !== "words" && flow.phase !== "prompts")) return;
    if (levelResult && levelResult.status !== "started") setFlow({ phase: "submitted", id: flow.id });
  }, [flow, levelResult]);

  useEffect(() => {
    return () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
    };
  }, []);

  const words = goal?.targets?.levelCheckWords ?? [];
  const prompts = goal?.targets?.levelCheckPrompts ?? [];
  const target = goal?.targets?.targetLanguage ?? "en";

  const toWords = (r: LiveMicResult) =>
    r.words.map((w) => ({
      text: w.text,
      // No confidence from the model: use the same neutral value scoring would assume.
      confidence: w.confidence ?? 0.5,
      start: w.start,
      end: w.end,
    }));

  const onMicError = useCallback((code: LiveMicError) => {
    if (code === "mic_blocked") setBlocked(true);
  }, []);

  function goToWord(index: number) {
    if (!flow || flow.phase === "intro" || flow.phase === "result" || flow.phase === "submitted") return;
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    setRetrySave(null);
    setSaving(false);
    setFlow({ phase: "words", id: flow.id, wordIndex: index });
  }

  function goToPrompt(index: number) {
    if (!flow || flow.phase === "intro" || flow.phase === "result" || flow.phase === "submitted") return;
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    setRetrySave(null);
    setSaving(false);
    setFlow({ phase: "prompts", id: flow.id, promptIndex: index });
  }

  async function onStart() {
    if (starting) return;
    setStarting(true);
    setStartFailed(false);
    try {
      const started = await startLevelCheck({});
      setFlow({ phase: "words", id: started.levelCheckId, wordIndex: 0 });
    } catch {
      setStartFailed(true);
    } finally {
      setStarting(false);
    }
  }

  async function saveWord(index: number, r: LiveMicResult) {
    if (flow?.phase !== "words") return;
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
      advanceTimer.current = setTimeout(() => {
        if (index + 1 < words.length) goToWord(index + 1);
        else goToPrompt(0);
      }, ADVANCE_MS);
    } catch {
      setSaving(false);
      setRetrySave(() => () => void saveWord(index, r));
    }
  }

  async function savePrompt(index: number, r: LiveMicResult) {
    if (flow?.phase !== "prompts") return;
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

  // ---- render ------------------------------------------------------------

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

  if (goal === undefined || counts === undefined || pass === undefined) return <Loading text={t("common.loading")} />;
  if (goal === null || !goal.targetsReady) {
    return <Loading testId="levelcheck-status" text={t("levelcheck.preparing")} />;
  }
  if (flow === null) return <Loading text={t("common.loading")} />;

  if (flow.phase === "intro") {
    return <IntroView onStart={() => void onStart()} busy={starting} failed={startFailed} onBack={() => router.back()} />;
  }

  if (flow.phase === "words") {
    const i = flow.wordIndex;
    return (
      <WordStep
        key={`w${i}-${micNonce}`}
        index={i}
        total={words.length}
        word={words[i] ?? ""}
        onFinal={(r) => void saveWord(i, r)}
        onSkip={() => {
          if (i + 1 < words.length) goToWord(i + 1);
          else goToPrompt(0);
        }}
        onBack={() => (i > 0 ? goToWord(i - 1) : setFlow({ phase: "intro" }))}
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
        onFinal={(r) => void savePrompt(i, r)}
        onBack={() => (i > 0 ? goToPrompt(i - 1) : goToWord(Math.max(0, words.length - 1)))}
        onError={onMicError}
        footer={notice}
      />
    );
  }

  if (flow.phase === "submitted") {
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
          onStartOver={() => {
            clearSnapshot();
            setFlow({ phase: "intro" });
          }}
        />
      );
    }
    return (
      <ProcessingView
        status={levelResult?.status ?? "processing"}
        onComplete={() => setFlow({ phase: "result", id: flow.id })}
      />
    );
  }

  // result
  const result = levelResult?.result;
  if (!result) return <Loading text={t("common.loading")} />;
  const meanings: Record<string, { meaning: string; hint: string | null }> = {};
  for (const w of goal.targets?.words ?? []) {
    meanings[w.word] = { meaning: w.meaning, hint: w.pronunciationHint ?? null };
  }
  const goalLabel =
    goal.goalType === "custom" ? goal.goalText : t(`goal.type.${goal.goalType}` as MessageKey);
  return (
    <ResultView
      goalType={goal.goalType}
      goalLabel={goalLabel}
      result={result}
      meanings={meanings}
      showDemoNote={DEMO_MODE}
      onContinue={() => router.push("/pay")}
    />
  );
}

function BoundaryFallback() {
  const { t } = useI18n();
  return (
    <Screen>
      <BrandHeader />
      <div className="mt-16 flex flex-col items-center gap-4 text-center">
        <p role="alert" className="text-base text-danger">
          {t("err.generic")}
        </p>
        <PrimaryButton type="button" onClick={() => window.location.reload()}>
          {t("mic.tryAgain")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}

/** A stale saved check (for example a deleted one) must not brick the screen. */
class FlowBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    clearSnapshot();
  }
  override render() {
    return this.state.failed ? <BoundaryFallback /> : this.props.children;
  }
}

export function LevelCheckFlow() {
  return (
    <FlowBoundary>
      <LevelCheckFlowInner />
    </FlowBoundary>
  );
}
