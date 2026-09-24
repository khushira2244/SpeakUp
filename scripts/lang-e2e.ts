/**
 * Live check of the multi-language generation prompts, on two fixed throwaway
 * accounts. Idempotent: every stage reuses what already exists, so a re-run
 * makes ZERO LLM calls.
 *
 *   npm run lang-e2e
 *
 *   test-de@speakup.dev  known [hi, en], primary hi, target de — the full flow:
 *                        goal targets -> level check (fake German transcripts)
 *                        -> scoring -> plan
 *   test-te@speakup.dev  known [te, en], primary te, target en — goal targets
 *                        only, to inspect Telugu pronunciation hints
 *
 * Only the microphone is faked (saveAttempt with fabricated transcripts).
 * LLM calls are attributed to steps by the schema name each one used.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const created: string[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const info = (m: string) => console.log(`  info  ${m}`);
const step = (t: string) => console.log(`\n▶ ${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pollUntil<T>(label: string, attempt: () => Promise<T | null>, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await attempt();
    if (result !== null) return result;
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const DEVANAGARI = /\p{Script=Devanagari}/u;
const TELUGU = /\p{Script=Telugu}/u;
const LATIN = /\p{Script=Latin}/u;

/** German umlaut/ß -> the ae/oe/ue/ss spelling a learner or ASR might produce. */
function germanVariant(word: string): string {
  return word
    .replace(/ß/g, "ss")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae")
    .replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue");
}
const hasUmlaut = (w: string) => /[äöüÄÖÜß]/.test(w);

function fakeWords(phrase: string, confidence: number) {
  return phrase
    .split(/\s+/)
    .filter(Boolean)
    .map((text, i) => ({ text, confidence, start: i * 400, end: i * 400 + 380 }));
}

async function signInFixed(client: ConvexHttpClient, email: string, password: string): Promise<void> {
  try {
    const r = await client.action(api.auth.signIn, {
      provider: "password",
      params: { email, password, flow: "signIn" },
    });
    if (typeof r.tokens?.token === "string") {
      client.setAuth(r.tokens.token);
      return;
    }
  } catch {
    // not created yet
  }
  const r = await client.action(api.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signUp" },
  });
  if (typeof r.tokens?.token !== "string") throw new Error(`could not sign in ${email}`);
  client.setAuth(r.tokens.token);
  created.push(`${email} account`);
}

type Profile = {
  knownLanguages: Array<"en" | "hi" | "te">;
  primaryLanguage: "en" | "hi" | "te";
  targetLanguage: "en" | "de";
  gender: "female" | "male" | "unspecified";
};
const GOAL = {
  goalType: "doctor" as const,
  goalText: "Explain my symptoms to a doctor and understand the instructions",
  deadline: "2_4_weeks" as const,
  minutesPerDay: 15 as const,
};

async function ensureProfile(client: ConvexHttpClient, profile: Profile): Promise<void> {
  const me = await client.query(api.users.me, {});
  const matches =
    me?.primaryLanguage === profile.primaryLanguage &&
    me?.targetLanguage === profile.targetLanguage &&
    me?.knownLanguages?.join(",") === profile.knownLanguages.join(",") &&
    me?.gender === profile.gender;
  if (!matches) {
    await client.mutation(api.users.updateProfile, profile);
    created.push("profile");
  }
  info(`profile: known=${profile.knownLanguages.join(",")} primary=${profile.primaryLanguage} target=${profile.targetLanguage}`);
}

/** Reuses a matching active goal with ready targets, else creates one. */
async function ensureTargets(client: ConvexHttpClient) {
  const existing = await client.query(api.goals.activeGoal, {});
  let goalId: Id<"goals">;
  if (
    existing !== null &&
    existing.goalType === GOAL.goalType &&
    existing.deadline === GOAL.deadline &&
    existing.minutesPerDay === GOAL.minutesPerDay &&
    existing.targetsReady
  ) {
    goalId = existing._id;
    info("reusing existing goal + targets");
  } else {
    goalId = await client.mutation(api.goals.setGoal, GOAL);
    created.push("goal targets");
    info("created goal; waiting for LLM goal-target generation");
  }
  const goal = await pollUntil("goal targets", async () => {
    const g = await client.query(api.goals.activeGoal, {});
    return g !== null && g._id === goalId && g.targets !== null ? g : null;
  });
  if (goal.targets === null) throw new Error("targets missing");
  return { goalId, targets: goal.targets };
}

async function counter(client: ConvexHttpClient): Promise<number> {
  return (await client.query(api.llmMetrics.total, {})).count;
}

/** LLM calls made since `before`, grouped by schema name (= pipeline step). */
async function callsSince(client: ConvexHttpClient, before: number): Promise<Record<string, number>> {
  const delta = (await counter(client)) - before;
  const grouped: Record<string, number> = {};
  if (delta <= 0) return grouped;
  for (const call of await client.query(api.llmMetrics.recent, { limit: delta })) {
    grouped[call.schemaName] = (grouped[call.schemaName] ?? 0) + 1;
  }
  return grouped;
}

const STEP_NAMES: Record<string, string> = {
  goal_targets: "goal targets",
  level_result_feedback: "level-check scoring",
  study_plan: "plan",
  pronunciation_hints: "hint backfill",
};

function printCalls(label: string, grouped: Record<string, number>): number {
  const total = Object.values(grouped).reduce((a, b) => a + b, 0);
  const parts = Object.entries(grouped).map(([k, n]) => `${STEP_NAMES[k] ?? k}: ${n}`);
  console.log(`  LLM calls — ${label}: ${total}${parts.length ? ` (${parts.join(", ")})` : ""}`);
  return total;
}

// ---------------------------------------------------------------------------
// German (hi primary) — full flow
// ---------------------------------------------------------------------------

async function germanFlow(url: string): Promise<Record<string, number>> {
  step("GERMAN — test-de@speakup.dev (known hi,en · primary hi · target de)");
  const client = new ConvexHttpClient(url);
  await signInFixed(client, "test-de@speakup.dev", "speakup-dev-fixed-password-de");
  const before = await counter(client);
  await ensureProfile(client, {
    knownLanguages: ["hi", "en"],
    primaryLanguage: "hi",
    targetLanguage: "de",
    gender: "female",
  });

  const { goalId, targets } = await ensureTargets(client);
  record(
    "snapshot: generated in de, explained in hi",
    targets.targetLanguage === "de" && targets.primaryLanguage === "hi",
  );
  record(
    "words are German (Latin script)",
    targets.words.every((w) => LATIN.test(w.word) && !DEVANAGARI.test(w.word)),
  );
  record(
    "every hint is Devanagari with no Latin letters",
    targets.words.every(
      (w) => w.pronunciationHint !== undefined && DEVANAGARI.test(w.pronunciationHint) && !LATIN.test(w.pronunciationHint),
    ),
  );
  record(
    "meanings are written in Hindi",
    targets.words.filter((w) => DEVANAGARI.test(w.meaning)).length >= targets.words.length * 0.9,
    `${targets.words.filter((w) => DEVANAGARI.test(w.meaning)).length}/${targets.words.length}`,
  );
  console.log("  sample German words:");
  for (const w of targets.words.slice(0, 8)) {
    console.log(`    ${w.word.padEnd(22)} ${w.pronunciationHint?.padEnd(18) ?? "-"} ${w.meaning}`);
  }
  console.log("  level-check prompts (stored as english=target, native=primary):");
  for (const p of targets.levelCheckPrompts) console.log(`    ${p.english}  |  ${p.native}`);
  console.log(`  level-check words: ${targets.levelCheckWords.join(", ")}`);

  // --- Level check with fake German transcripts ---------------------------
  const vocabulary = targets.words.map((w) => w.word);
  const progress = await client.query(api.home.progressCounts, {});
  let levelCheckId: Id<"levelChecks">;
  let variantWords: string[] = [];
  if (progress !== null && progress.goalId === goalId) {
    levelCheckId = progress.levelCheckId;
    info("reusing existing scored level check");
  } else {
    created.push("level check + scoring");
    const started = await client.mutation(api.levelCheck.startLevelCheck, {});
    levelCheckId = started.levelCheckId;
    const confidences = [0.95, 0.91, 0.88, 0.62];
    for (let i = 0; i < started.words.length; i++) {
      const expected = started.words[i]!;
      const missing = i === 4;
      const transcript = missing ? "äh, das weiß ich nicht" : expected;
      await client.mutation(api.levelCheck.saveAttempt, {
        levelCheckId,
        kind: "word",
        index: i,
        expected,
        transcript,
        words: fakeWords(transcript, missing ? 0.4 : (confidences[i] ?? 0.9)),
        source: "streaming",
        languageDetected: "de",
      });
    }
    // Answer words: the first 6 goal words, plus up to 2 umlaut/ß words from
    // anywhere in the vocabulary. Umlaut words are written with ae/oe/ue/ss
    // to prove the German-aware matcher still credits them.
    const umlautWords = vocabulary.filter(hasUmlaut).slice(0, 2);
    const answerWords = [...new Set([...vocabulary.slice(0, 6), ...umlautWords])];
    variantWords = answerWords.filter(hasUmlaut);
    const spoken = answerWords.map((w) => (hasUmlaut(w) ? germanVariant(w) : w));
    const half = Math.ceil(spoken.length / 2);
    const answers = [
      `Guten Tag Herr Doktor, ich habe ${spoken.slice(0, half).join(" und ")} seit gestern.`,
      `Ja, ich verstehe, ich brauche ${spoken.slice(half).join(" und ")}. Vielen Dank.`,
    ];
    for (let i = 0; i < started.prompts.length; i++) {
      const transcript = answers[i]!;
      await client.mutation(api.levelCheck.saveAttempt, {
        levelCheckId,
        kind: "prompt",
        index: i,
        expected: started.prompts[i]!.english,
        transcript,
        words: fakeWords(transcript, 0.9),
        source: "streaming",
        languageDetected: "de",
      });
    }
    console.log("  fake German answers:");
    for (const a of answers) console.log(`    ${a}`);
    await client.mutation(api.levelCheck.finishLevelCheck, { levelCheckId });
  }

  const scored = await pollUntil("scoring", async () => {
    const r = await client.query(api.scoring.levelResult, { levelCheckId });
    return r.status === "done" || r.status === "failed" ? r : null;
  });
  if (scored.status === "failed" || scored.result === null) {
    record("scoring completed", false, scored.error ?? "no result");
    return callsSince(client, before);
  }
  const result = scored.result;
  record("scoring done", true, `level=${result.level} canUse=${result.canUse.length} practising=${result.practising.length} notYet=${result.notYet.length}`);
  record("speaking summary written in Hindi", DEVANAGARI.test(result.speakingSummary), result.speakingSummary.slice(0, 110));
  if (variantWords.length > 0) {
    record(
      "umlaut/ß words spoken as ae/oe/ue/ss still landed in canUse",
      variantWords.every((w) => result.canUse.includes(w)),
      variantWords.map((w) => `${w} ← "${germanVariant(w)}"`).join(", "),
    );
  } else {
    info("no umlaut/ß words in this vocabulary (or level check reused) — variant check skipped");
  }

  // --- Plan -----------------------------------------------------------------
  const existingPlan = await client.query(api.plans.plan, { goalId });
  if (existingPlan === null) created.push("plan");
  const plan = await pollUntil("plan", () => client.query(api.plans.plan, { goalId }));
  record(
    "week plan: 7 days × 5 words, 1 German pattern/day",
    plan.mode === "week" && plan.days.length === 7 && plan.days.every((d) => d.words.length === 5 && d.patterns.length === 1),
  );
  const hintOf = new Map(targets.words.map((w) => [w.word, w.pronunciationHint]));
  record(
    "plan hints copied from goalTargets by word (no LLM)",
    plan.days.every((d) => d.words.every((w) => w.pronunciationHint !== undefined && w.pronunciationHint === hintOf.get(w.word))),
  );
  record(
    "plan titles and practice instructions written in Hindi",
    plan.days.every((d) => DEVANAGARI.test(d.title) && DEVANAGARI.test(d.practiceSummary)),
    `day 1: "${plan.days[0]?.title}"`,
  );

  // --- Streaming routing from the goal snapshot -----------------------------
  const target = await client.query(api.levelCheck.getStreamConfig, { purpose: "target" });
  const own = await client.query(api.levelCheck.getStreamConfig, { purpose: "own" });
  record(
    "getStreamConfig: target → u3-rt-pro/de, own → whisper-rt/hi (from goal snapshot)",
    target.speechModel === "u3-rt-pro" && target.language === "de" && target.languageSource === "goal" &&
      own.speechModel === "whisper-rt" && own.language === "hi",
  );

  return callsSince(client, before);
}

// ---------------------------------------------------------------------------
// Telugu primary — goal targets only
// ---------------------------------------------------------------------------

async function teluguFlow(url: string): Promise<Record<string, number>> {
  step("TELUGU — test-te@speakup.dev (known te,en · primary te · target en) — targets only");
  const client = new ConvexHttpClient(url);
  await signInFixed(client, "test-te@speakup.dev", "speakup-dev-fixed-password-te");
  const before = await counter(client);
  await ensureProfile(client, {
    knownLanguages: ["te", "en"],
    primaryLanguage: "te",
    targetLanguage: "en",
    gender: "unspecified",
  });
  const { targets } = await ensureTargets(client);
  record(
    "snapshot: generated in en, explained in te",
    targets.targetLanguage === "en" && targets.primaryLanguage === "te",
  );
  record(
    "every hint is Telugu script with no Latin letters",
    targets.words.every(
      (w) => w.pronunciationHint !== undefined && TELUGU.test(w.pronunciationHint) && !LATIN.test(w.pronunciationHint),
    ),
  );
  record(
    "meanings are written in Telugu",
    targets.words.filter((w) => TELUGU.test(w.meaning)).length >= targets.words.length * 0.9,
    `${targets.words.filter((w) => TELUGU.test(w.meaning)).length}/${targets.words.length}`,
  );
  console.log("  sample English words with Telugu hints:");
  for (const w of targets.words.slice(0, 8)) {
    console.log(`    ${w.word.padEnd(18)} ${w.pronunciationHint?.padEnd(16) ?? "-"} ${w.meaning}`);
  }
  const own = await client.query(api.levelCheck.getStreamConfig, { purpose: "own" });
  record("getStreamConfig own → whisper-rt/te", own.speechModel === "whisper-rt" && own.language === "te");
  return callsSince(client, before);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("SpeakUp — multi-language generation check");
  console.log("=".repeat(60));
  const match = readFileSync(path.join(ROOT, ".env.local"), "utf8").match(/^CONVEX_URL=(.+)$/m);
  if (match === null || match[1] === undefined) throw new Error("CONVEX_URL missing from .env.local");
  const url = match[1].trim();

  const de = await germanFlow(url);
  const te = await teluguFlow(url);

  step("LLM Gateway usage");
  const deTotal = printCalls("German account", de);
  const teTotal = printCalls("Telugu account", te);
  console.log(`  total this run: ${deTotal + teTotal}`);
  console.log(`  created this run: ${created.length ? created.join(", ") : "(nothing — everything reused)"}`);
  if (created.length === 0) {
    record("idempotent re-run made ZERO LLM calls", deTotal + teTotal === 0, `${deTotal + teTotal} calls`);
  }
}

main()
  .then(() => {
    const failed = checks.filter((c) => !c.ok);
    console.log("\n" + "=".repeat(60));
    console.log(`RESULT: ${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length) {
      for (const c of failed) console.log(`  ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
