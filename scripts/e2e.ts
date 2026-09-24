/**
 * End-to-end flow test for SpeakUp.
 *
 * Runs the real backend against the real Convex dev deployment with real
 * Convex Auth and a real LLM. The ONLY thing faked is the microphone: instead
 * of streaming audio to AssemblyAI, the script calls `levelCheck.saveAttempt`
 * with fabricated transcripts. Nothing inside the backend is mocked or stubbed.
 *
 *   npm run seed         idempotent: reuses whatever already exists
 *   npm run seed:fresh   wipes the test account's state and regenerates
 *
 * DEV RULE: this script always uses ONE fixed account (test@speakup.dev) and is
 * idempotent by default. Every stage queries the deployment for existing state
 * and reuses it; only genuinely missing state is created. A normal re-run
 * therefore makes ZERO LLM Gateway calls, which the summary asserts.
 *
 * `--fresh` is the only path that regenerates.
 *
 * Requires on the Convex deployment:
 *   ASSEMBLYAI_API_KEY   LLM Gateway calls (goal targets, scoring, plan
 *                        generation) and, in production, speech-to-text
 * Optional:
 *   LLM_MODEL            defaults to "gemini-2.5-flash-lite"
 *   LLM_BASE_URL         defaults to the AssemblyAI LLM Gateway endpoint
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONVEX_CLI = path.join(ROOT, "node_modules", "convex", "bin", "main.js");

/**
 * `npm run seed -- --fresh` does NOT reliably forward the flag (npm on Windows
 * swallows the `--`), so `npm run seed:fresh` and `SEED_FRESH=1` are supported
 * as well. All three set the same switch.
 */
const FRESH =
  process.argv.slice(2).includes("--fresh") || process.env.SEED_FRESH === "1";

/** The one fixed dev account. Never randomised. */
const TEST_EMAIL = "test@speakup.dev";
const TEST_PASSWORD = "speakup-dev-fixed-password-1";
/** A second fixed account, used only for the ownership-isolation checks. */
const OTHER_EMAIL = "test-other@speakup.dev";
const OTHER_PASSWORD = "speakup-dev-fixed-password-2";

/** The goal configuration this script asserts against. */
const GOAL = {
  goalType: "doctor",
  goalText: "Explain my symptoms to a doctor and understand the instructions",
  deadline: "2_4_weeks",
  minutesPerDay: 15,
} as const;
/** 15 minutes/day → 5 words/day, and "2_4_weeks" → a 7-day week plan. */
const EXPECTED_WORDS_PER_DAY = 5;
const EXPECTED_DAY_COUNT = 7;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
/** What this run had to create vs. what it reused. */
const created: string[] = [];
const reused: string[] = [];
/** Gateway requests made by the one-time pronunciation-hint backfill this run. */
let backfillLlmCalls = 0;
/** Goal word (lower-cased) -> its pronunciation hint, for the plan-copy check. */
let hintByWord = new Map<string, string | undefined>();

function record(name: string, ok: boolean, detail = ""): boolean {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function step(title: string): void {
  console.log(`\n▶ ${title}`);
}

function info(message: string): void {
  console.log(`  info  ${message}`);
}

class Fatal extends Error {}

function fatal(message: string): never {
  throw new Fatal(message);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pollUntil<T>(
  label: string,
  timeoutMs: number,
  intervalMs: number,
  attempt: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await attempt();
    if (result !== null) return result;
    await sleep(intervalMs);
  }
  fatal(`Timed out after ${timeoutMs / 1000}s waiting for ${label}`);
}

function runConvexCli(args: string[]): string {
  // Invoke the Convex CLI through Node rather than `npx`: spawning a `.cmd`
  // shim without a shell fails with EINVAL on modern Node for Windows.
  return execFileSync(process.execPath, [CONVEX_CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function readConvexUrl(): string {
  const envPath = path.join(ROOT, ".env.local");
  if (!existsSync(envPath)) {
    fatal(".env.local not found. Run `npx convex dev --once` first.");
  }
  const match = readFileSync(envPath, "utf8").match(/^CONVEX_URL=(.+)$/m);
  if (match === null || match[1] === undefined) {
    fatal("CONVEX_URL not found in .env.local. Run `npx convex dev --once` first.");
  }
  return match[1].trim();
}

function deploymentEnvNames(): string[] {
  try {
    return runConvexCli(["env", "list"])
      .split(/\r?\n/)
      .map((line) => line.split("=")[0]?.trim() ?? "")
      .filter((name) => name.length > 0);
  } catch (error) {
    fatal(
      `Could not read deployment env vars: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function preflight(): void {
  step("Preflight: deployment dependencies");
  const names = new Set(deploymentEnvNames());

  // ASSEMBLYAI_API_KEY authenticates the LLM Gateway, which every generation
  // stage in this flow depends on.
  if (!names.has("ASSEMBLYAI_API_KEY")) {
    console.error(
      `\n✗ MISSING DEPENDENCY — this script exercises the real LLM pipeline and cannot run without it.\n` +
        `  Not set on the Convex deployment: ASSEMBLYAI_API_KEY\n\n` +
        `  Set it with:\n` +
        `    npx convex env set ASSEMBLYAI_API_KEY <your-key>\n\n` +
        `  The key also needs AssemblyAI LLM Gateway access enabled on the account;\n` +
        `  without it the gateway returns 400 "Your account does not have access to\n` +
        `  this LLM Gateway model".\n\n` +
        `  The backend itself never fakes LLM output, so there is no offline mode.\n`,
    );
    process.exit(2);
  }
  record("ASSEMBLYAI_API_KEY set on deployment", true, "authenticates the LLM Gateway");
  info(
    `model: ${names.has("LLM_MODEL") ? "LLM_MODEL override set" : 'default "gemini-2.5-flash-lite"'}`,
  );
  info(
    `endpoint: ${names.has("LLM_BASE_URL") ? "LLM_BASE_URL override set" : "default AssemblyAI LLM Gateway"}`,
  );
  info(
    `mode: ${FRESH ? "--fresh (wipe and regenerate)" : "idempotent (reuse existing state)"}`,
  );
}

// ---------------------------------------------------------------------------
// Auth against the fixed accounts
// ---------------------------------------------------------------------------

/** Signs in to the fixed account, creating it only if it does not exist yet. */
async function authenticate(
  client: ConvexHttpClient,
  email: string,
  password: string,
): Promise<{ token: string; createdAccount: boolean }> {
  try {
    const signedIn = await client.action(api.auth.signIn, {
      provider: "password",
      params: { email, password, flow: "signIn" },
    });
    const token = signedIn.tokens?.token;
    if (typeof token === "string") return { token, createdAccount: false };
  } catch {
    // Falls through to sign-up: the account does not exist yet.
  }

  const signedUp = await client.action(api.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signUp" },
  });
  const token = signedUp.tokens?.token;
  if (typeof token !== "string") {
    fatal(`Could not sign in or sign up ${email}. Response: ${JSON.stringify(signedUp)}`);
  }
  return { token, createdAccount: true };
}

// ---------------------------------------------------------------------------
// Fake transcript builders (the microphone, and only the microphone, is faked)
// ---------------------------------------------------------------------------

type FakeWord = { text: string; confidence: number; start: number; end: number };

function fakeWordsFor(phrase: string, confidence: number, startMs = 0): FakeWord[] {
  return phrase
    .split(/\s+/)
    .filter(Boolean)
    .map((token, i) => ({
      text: token,
      confidence,
      start: startMs + i * 400,
      end: startMs + i * 400 + 380,
    }));
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("SpeakUp by AdaptiveSkills — end-to-end flow test");
  console.log("=".repeat(60));

  preflight();

  const convexUrl = readConvexUrl();
  const client = new ConvexHttpClient(convexUrl);
  console.log(`\n  Deployment: ${convexUrl}`);

  // --- 1. Fixed account -----------------------------------------------------
  step("1. Sign in to the fixed test account");
  const auth = await authenticate(client, TEST_EMAIL, TEST_PASSWORD);
  client.setAuth(auth.token);
  record(
    "authenticated as the fixed dev account",
    true,
    `${TEST_EMAIL} (${auth.createdAccount ? "account created" : "existing account reused"})`,
  );
  (auth.createdAccount ? created : reused).push("account");

  // Baseline reading of the gateway call counter. Diffing two readings avoids
  // depending on clock agreement between this machine and the deployment.
  const llmBefore = (await client.query(api.llmMetrics.total, {})).count;
  info(`LLM Gateway calls recorded before this run: ${llmBefore}`);

  // --- 1b. --fresh: wipe -----------------------------------------------------
  if (FRESH) {
    step("1b. --fresh: wiping the test accounts' state");
    for (const email of [TEST_EMAIL, OTHER_EMAIL]) {
      const output = runConvexCli(["run", "dev:devReset", JSON.stringify({ email })]);
      info(`devReset ${email}: ${output.trim().replace(/\s+/g, " ").slice(0, 200)}`);
    }
    record("state wiped for regeneration", true, "only --fresh may regenerate");
  }

  // Unauthenticated callers must be rejected everywhere.
  const anon = new ConvexHttpClient(convexUrl);
  let anonRejected = false;
  try {
    await anon.query(api.goals.activeGoal, {});
  } catch {
    anonRejected = true;
  }
  record("unauthenticated caller is rejected by goals.activeGoal", anonRejected);

  // --- 2. Profile -----------------------------------------------------------
  step("2. Language profile");
  // Matches what the nativeLanguage -> profile migration produced for this
  // account ("hi" -> known [hi], primary hi, target en), so it is reused.
  const PROFILE = {
    knownLanguages: ["hi"] as Array<"en" | "hi" | "te">,
    primaryLanguage: "hi" as const,
    targetLanguage: "en" as const,
  };
  const existingProfile = await client.query(api.users.me, {});
  const profileMatches =
    existingProfile?.knownLanguages?.includes("hi") === true &&
    existingProfile.primaryLanguage === PROFILE.primaryLanguage &&
    existingProfile.targetLanguage === PROFILE.targetLanguage &&
    existingProfile.gender === "female";
  if (profileMatches) {
    reused.push("profile");
    info("profile already set — skipping updateProfile");
  } else {
    await client.mutation(api.users.updateProfile, { ...PROFILE, gender: "female" });
    created.push("profile");
  }
  const me = await client.query(api.users.me, {});
  record(
    "users.me reflects the profile",
    me?.primaryLanguage === "hi" && me?.targetLanguage === "en" && me?.gender === "female",
    `known=${me?.knownLanguages?.join(",")} primary=${me?.primaryLanguage} target=${me?.targetLanguage} gender=${me?.gender}`,
  );

  // --- 3. Goal (existence check: activeGoal with the expected config) -------
  step("3. Set goal + deadline + daily minutes");
  const existingGoal = await client.query(api.goals.activeGoal, {});
  const goalMatches =
    existingGoal !== null &&
    existingGoal.goalType === GOAL.goalType &&
    existingGoal.deadline === GOAL.deadline &&
    existingGoal.minutesPerDay === GOAL.minutesPerDay;
  // A goal whose targets never generated is unusable: setGoal is the only
  // thing that schedules generation, so re-create rather than hang.
  const goalUsable = goalMatches && existingGoal !== null && existingGoal.targetsReady;

  let goalId: Id<"goals">;
  if (goalUsable && existingGoal !== null) {
    goalId = existingGoal._id;
    reused.push("goal + goalTargets");
    record("reused the existing active goal", true, goalId);
  } else {
    if (existingGoal !== null && !goalMatches) {
      info("active goal has a different config — creating one that matches");
    } else if (existingGoal !== null && !existingGoal.targetsReady) {
      info("active goal has no goalTargets — re-creating to re-trigger generation");
    }
    goalId = await client.mutation(api.goals.setGoal, GOAL);
    created.push("goal");
    record("goals.setGoal created a goal", typeof goalId === "string", goalId);
  }

  // --- 4. Goal targets (existence check: targetsReady) ----------------------
  step("4. Goal targets (LLM)");
  const goal = await pollUntil("goal targets", 180_000, 2_000, async () => {
    const active = await client.query(api.goals.activeGoal, {});
    return active !== null && active._id === goalId && active.targetsReady ? active : null;
  });
  const targets = goal.targets;
  if (targets === null) fatal("targetsReady was true but targets were null");
  if (!reused.includes("goal + goalTargets")) created.push("goalTargets");

  record(
    "goal targets: ~40 words with native-language meanings",
    targets.words.length >= 25,
    `${targets.words.length} words, e.g. "${targets.words[0]?.word}" = "${targets.words[0]?.meaning}"`,
  );
  record(
    "goal targets: 4–6 grammar patterns",
    targets.patterns.length >= 4 && targets.patterns.length <= 6,
    `${targets.patterns.length} patterns`,
  );
  record(
    "goal targets: exactly 5 level-check words",
    targets.levelCheckWords.length === 5,
    targets.levelCheckWords.join(", "),
  );
  record(
    "goal targets: exactly 2 level-check prompts with native translations",
    targets.levelCheckPrompts.length === 2 &&
      targets.levelCheckPrompts.every((p) => p.english.length > 0 && p.native.length > 0),
    targets.levelCheckPrompts.map((p) => p.english).join(" | "),
  );

  const vocabulary = targets.words.map((w) => w.word);

  // --- 4b. Pronunciation hints (idempotent backfill; never regenerates) -----
  step("4b. Pronunciation hints");
  // Targets generated before hints existed get them from ONE small LLM call;
  // once every word has a hint this makes no call at all.
  const backfill = JSON.parse(
    runConvexCli([
      "run",
      "migrations:backfillPronunciationHints",
      JSON.stringify({ email: TEST_EMAIL }),
    ]),
  ) as { llmCalls: number; missingBefore: number; wordsFilled: number; planWordsFilled: number };
  backfillLlmCalls = backfill.llmCalls;
  if (backfill.missingBefore > 0) created.push("pronunciation hints (backfill)");
  else reused.push("pronunciation hints");
  info(
    `backfill: ${backfill.missingBefore} words missing hints, ${backfill.wordsFilled} filled, ${backfill.planWordsFilled} plan words filled, ${backfill.llmCalls} LLM call(s)`,
  );
  const hinted = await client.query(api.goals.activeGoal, {});
  const hintedWords = hinted?.targets?.words ?? [];
  hintByWord = new Map(hintedWords.map((w) => [w.word.toLowerCase(), w.pronunciationHint]));
  record(
    "every goal word has a pronunciation hint in Devanagari (primary hi)",
    hintedWords.length > 0 &&
      hintedWords.every(
        (w) =>
          typeof w.pronunciationHint === "string" &&
          /\p{Script=Devanagari}/u.test(w.pronunciationHint) &&
          !/\p{Script=Latin}/u.test(w.pronunciationHint),
      ),
    hintedWords
      .slice(0, 4)
      .map((w) => `${w.word} → ${w.pronunciationHint}`)
      .join(", "),
  );
  record(
    "targets carry their generation-language snapshot (en target, hi primary)",
    hinted?.targets?.targetLanguage === "en" && hinted?.targets?.primaryLanguage === "hi",
  );

  // --- 5. Level check (existence check: a scored levelResult for this goal) -
  step("5. Level check + scoring");
  const existingProgress = await client.query(api.home.progressCounts, {});
  const scoredAlready = existingProgress !== null && existingProgress.goalId === goalId;

  let levelCheckId: Id<"levelChecks">;
  if (scoredAlready && existingProgress !== null) {
    levelCheckId = existingProgress.levelCheckId;
    reused.push("levelCheck + levelResult");
    record("reused the existing scored level check", true, levelCheckId);
  } else {
    const started = await client.mutation(api.levelCheck.startLevelCheck, {});
    levelCheckId = started.levelCheckId;
    record(
      "levelCheck.startLevelCheck returned 5 words + 2 prompts",
      started.words.length === 5 && started.prompts.length === 2,
      levelCheckId,
    );

    // 5 fake word attempts. Deliberately mixed so every branch of the
    // deterministic grader is hit: 3 clear, 1 unclear, 1 not spoken.
    const wordConfidences = [0.95, 0.91, 0.88, 0.62];
    for (let i = 0; i < started.words.length; i++) {
      const expected = started.words[i]!;
      const isMissing = i === 4;
      const transcript = isMissing ? "um sorry i don't know" : expected;
      const confidence = wordConfidences[i] ?? 0.9;
      await client.mutation(api.levelCheck.saveAttempt, {
        levelCheckId,
        kind: "word",
        index: i,
        expected,
        transcript,
        words: isMissing
          ? fakeWordsFor(transcript, 0.4)
          : fakeWordsFor(expected, confidence),
        source: "streaming",
      });
    }
    record("saved 5 word attempts", true, "3 clear, 1 unclear, 1 not spoken");

    // 2 fake prompt answers seeded with real goal words.
    const answers = [
      `hello doctor i have ${vocabulary.slice(0, 4).join(" and ")} since yesterday please help me`,
      `yes i understand i will take the ${vocabulary.slice(4, 8).join(" and ")} thank you very much`,
    ];
    for (let i = 0; i < started.prompts.length; i++) {
      const transcript = answers[i]!;
      await client.mutation(api.levelCheck.saveAttempt, {
        levelCheckId,
        kind: "prompt",
        index: i,
        expected: started.prompts[i]!.english,
        transcript,
        words: fakeWordsFor(transcript, 0.9),
        source: "streaming",
        languageDetected: "en",
      });
    }
    record(
      "saved 2 prompt attempts",
      true,
      `seeded with goal words: ${vocabulary.slice(0, 8).join(", ")}`,
    );

    await client.mutation(api.levelCheck.finishLevelCheck, { levelCheckId });
    created.push("levelCheck + levelResult");
  }

  const scored = await pollUntil("scoring to finish", 180_000, 2_000, async () => {
    const r = await client.query(api.scoring.levelResult, { levelCheckId });
    return r.status === "done" || r.status === "failed" ? r : null;
  });
  if (scored.status === "failed") {
    record("scoring completed", false, `levelCheck.status = failed: ${scored.error}`);
    fatal(`Scoring failed: ${scored.error}`);
  }
  const result = scored.result;
  if (result === null) fatal("status was done but result was null");

  record("scoring completed with status done", true, `level = ${result.level}`);
  record(
    "words bucketed into canUse / practising / notYet",
    result.canUse.length + result.practising.length + result.notYet.length ===
      targets.words.length,
    `canUse=${result.canUse.length} practising=${result.practising.length} notYet=${result.notYet.length} (total ${result.totalCount})`,
  );
  record(
    "words spoken in the answers landed in canUse",
    result.canUse.length > 0,
    result.canUse.slice(0, 6).join(", "),
  );
  record(
    "grammar status returned for every goal pattern",
    result.grammar.length === targets.patterns.length &&
      result.grammar.every((g) => ["ok", "practising", "not_yet"].includes(g.status)),
    result.grammar.map((g) => g.status).join(", "),
  );
  record(
    "speaking summary written in the native language (hi = Devanagari)",
    /[ऀ-ॿ]/.test(result.speakingSummary),
    result.speakingSummary.slice(0, 120),
  );

  // --- 6. Plan (existence check: plans.plan for this goal) ------------------
  step("6. Plan");
  const existingPlan = await client.query(api.plans.plan, { goalId });
  if (existingPlan !== null) {
    reused.push("plan");
    record("reused the existing plan", true, existingPlan._id);
  } else {
    created.push("plan");
    info("no plan yet — waiting for the generation scheduled by scoring");
  }

  const plan = await pollUntil("plan generation", 180_000, 2_500, async () =>
    client.query(api.plans.plan, { goalId }),
  );
  record("plan exists for the goal", true, `mode = ${plan.mode}, ${plan.days.length} days`);
  record(
    `deadline "${GOAL.deadline}" produced a ${EXPECTED_DAY_COUNT}-day week plan`,
    plan.mode === "week" && plan.days.length === EXPECTED_DAY_COUNT,
    `mode=${plan.mode} days=${plan.days.length}`,
  );
  record(
    `${GOAL.minutesPerDay} minutes/day → ${EXPECTED_WORDS_PER_DAY} words per day on every day`,
    plan.days.every((d) => d.words.length === EXPECTED_WORDS_PER_DAY),
    plan.days.map((d) => d.words.length).join(","),
  );
  record(
    "1 grammar pattern per day, every day titled and has a practice task",
    plan.days.every(
      (d) => d.patterns.length === 1 && d.title.length > 0 && d.practiceSummary.length > 0,
    ),
  );
  record(
    "every plan word came from the goal vocabulary (no LLM invention)",
    plan.days.every((d) =>
      d.words.every((w) => vocabulary.some((v) => v.toLowerCase() === w.word.toLowerCase())),
    ),
  );
  record(
    "plan word hints are copied from goalTargets (deterministic, by word)",
    plan.days.every((d) =>
      d.words.every(
        (w) =>
          w.pronunciationHint !== undefined &&
          w.pronunciationHint === hintByWord.get(w.word.toLowerCase()),
      ),
    ),
  );

  // Re-running generation must not regenerate (this short-circuits before any
  // gateway call, which is what keeps an idempotent re-run at zero).
  const regenAttempt = await client.action(api.plans.generatePlan, { goalId });
  record(
    "plans.generatePlan is a no-op when a plan already exists",
    regenAttempt.created === false && regenAttempt.planId === plan._id,
  );

  // Regeneration without a paid purchase must be refused.
  let regenBlocked = false;
  try {
    await client.action(api.purchases.regenPlan, { goalId });
  } catch {
    regenBlocked = true;
  }
  record("purchases.regenPlan is refused without a paid regen purchase", regenBlocked);

  // --- 7. Purchase (existence check: canAccess on a non-preview day) --------
  step("7. Demo purchase and access gating");
  // Day 2 is only unlocked by a week purchase, so it is the cleanest probe.
  const day2Before = await client.query(api.purchases.canAccess, {
    planId: plan._id,
    dayNo: 2,
  });
  const alreadyPurchased = day2Before.unlocked;

  if (alreadyPurchased) {
    reused.push("week purchase");
    info("week purchase already exists — skipping the pre-purchase locked assertions");
  } else {
    // These only hold before the purchase exists.
    const day1Before = await client.query(api.purchases.canAccess, {
      planId: plan._id,
      dayNo: 1,
    });
    const day3Before = await client.query(api.purchases.canAccess, {
      planId: plan._id,
      dayNo: 3,
    });
    record(
      "day 1 preview is visible but locked",
      day1Before.previewAvailable && !day1Before.unlocked,
    );
    record("day 3 is fully locked", !day3Before.previewAvailable && !day3Before.unlocked);

    const cardBefore = await client.query(api.home.todayCard, { now: Date.now() });
    record(
      "home.todayCard withholds the lesson body while locked",
      cardBefore !== null &&
        cardBefore.dayNo === 1 &&
        cardBefore.practiceSummary === null &&
        cardBefore.words.length === EXPECTED_WORDS_PER_DAY,
      "title + words + patterns visible, practiceSummary null",
    );
  }

  const bought = await client.mutation(api.purchases.purchase, {
    planId: plan._id,
    type: "week",
  });
  if (!alreadyPurchased) created.push("week purchase");
  record(
    "week purchase recorded at $4.99",
    bought.amountUsd === 4.99,
    `$${bought.amountUsd}${bought.alreadyOwned ? " (already owned — no second charge)" : ""}`,
  );

  const accessAfter: Array<{ dayNo: number; unlocked: boolean }> = [];
  for (let dayNo = 1; dayNo <= plan.days.length; dayNo++) {
    const access = await client.query(api.purchases.canAccess, { planId: plan._id, dayNo });
    accessAfter.push({ dayNo, unlocked: access.unlocked });
  }
  record(
    `week purchase unlocks all ${EXPECTED_DAY_COUNT} days`,
    accessAfter.every((a) => a.unlocked),
    accessAfter.map((a) => `d${a.dayNo}:${a.unlocked ? "open" : "locked"}`).join(" "),
  );

  const cardAfter = await client.query(api.home.todayCard, { now: Date.now() });
  record(
    "home.todayCard now returns the full lesson body",
    cardAfter !== null && cardAfter.practiceSummary !== null && cardAfter.access.unlocked,
    cardAfter?.practiceSummary?.slice(0, 90),
  );

  const progress = await client.query(api.home.progressCounts, {});
  record(
    "home.progressCounts matches the level result",
    progress !== null &&
      progress.canUse === result.canUse.length &&
      progress.practising === result.practising.length &&
      progress.notYet === result.notYet.length,
    progress
      ? `canUse=${progress.canUse} practising=${progress.practising} notYet=${progress.notYet} level=${progress.level}`
      : "null",
  );

  // --- 8. Ownership isolation (second fixed account) ------------------------
  step("8. Another signed-in user cannot touch these records");
  const other = new ConvexHttpClient(convexUrl);
  const otherAuth = await authenticate(other, OTHER_EMAIL, OTHER_PASSWORD);
  other.setAuth(otherAuth.token);
  record(
    "second fixed account available",
    true,
    `${OTHER_EMAIL} (${otherAuth.createdAccount ? "created" : "reused"})`,
  );

  let planBlocked = false;
  try {
    await other.query(api.plans.plan, { goalId });
  } catch {
    planBlocked = true;
  }
  record("plans.plan rejects another user's goalId", planBlocked);

  let accessBlocked = false;
  try {
    await other.query(api.purchases.canAccess, { planId: plan._id, dayNo: 1 });
  } catch {
    accessBlocked = true;
  }
  record("purchases.canAccess rejects another user's planId", accessBlocked);

  let levelBlocked = false;
  try {
    await other.query(api.scoring.levelResult, { levelCheckId });
  } catch {
    levelBlocked = true;
  }
  record("scoring.levelResult rejects another user's levelCheckId", levelBlocked);

  // --- 9. LLM usage ---------------------------------------------------------
  step("9. LLM Gateway usage for this run");
  const llmAfter = (await client.query(api.llmMetrics.total, {})).count;
  const llmCalls = llmAfter - llmBefore;
  console.log(`  LLM GATEWAY CALLS THIS RUN: ${llmCalls}`);
  console.log(`  created: ${created.length > 0 ? created.join(", ") : "(nothing)"}`);
  console.log(`  reused:  ${reused.length > 0 ? reused.join(", ") : "(nothing)"}`);

  if (llmCalls > 0) {
    const recentCalls = await client.query(api.llmMetrics.recent, { limit: llmCalls });
    for (const call of [...recentCalls].reverse()) {
      console.log(
        `    - ${call.schemaName} attempt ${call.attempt} ${call.ok ? "ok" : `FAILED (${call.errorName})`}`,
      );
    }
  }

  const createdOtherThanBackfill = created.filter((c) => c !== "pronunciation hints (backfill)");
  console.log(`  of which the pronunciation-hint backfill: ${backfillLlmCalls}`);

  if (FRESH) {
    record(
      "--fresh regenerated everything (LLM calls > 0)",
      llmCalls > 0,
      `${llmCalls} gateway calls`,
    );
  } else if (createdOtherThanBackfill.length === 0) {
    record(
      "idempotent re-run made ZERO LLM Gateway calls apart from the one-time hint backfill",
      llmCalls - backfillLlmCalls === 0 && backfillLlmCalls <= 2,
      `${llmCalls} gateway calls total, ${backfillLlmCalls} of them the hint backfill`,
    );
  } else {
    info(
      `first run for this account (created: ${created.join(", ")}) — ${llmCalls} gateway calls expected`,
    );
    record("state now exists for reuse on the next run", true);
  }
}

// ---------------------------------------------------------------------------

main()
  .then(() => {
    const failed = checks.filter((c) => !c.ok);
    console.log("\n" + "=".repeat(60));
    console.log(`RESULT: ${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length > 0) {
      console.log("\nFailed checks:");
      for (const c of failed) console.log(`  ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      console.log("\n✗ END-TO-END FLOW FAILED");
      process.exit(1);
    }
    console.log("✓ END-TO-END FLOW PASSED");
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.log("\n" + "=".repeat(60));
    const failed = checks.filter((c) => !c.ok);
    console.log(
      `RESULT: ${checks.length - failed.length}/${checks.length} checks passed before the run aborted`,
    );
    console.error(
      `\n✗ END-TO-END FLOW FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (error instanceof Error && !(error instanceof Fatal) && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  });
