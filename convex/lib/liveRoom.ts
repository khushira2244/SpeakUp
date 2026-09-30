/**
 * Pure rules for the live room: join-window timing, auto-end grace, script-
 * line matching (deterministic word overlap, no LLM), and stuck-silence
 * detection. No Convex imports, so scripts/verify.ts can test all of it
 * without a deployment — matching the convention in lib/rooms.ts.
 */

import { matchTokens } from "./languages";

// ---------------------------------------------------------------------------
// Timing windows
// ---------------------------------------------------------------------------

/** A participant may join starting this long before the scheduled start. */
export const JOIN_WINDOW_BEFORE_START_MS = 5 * 60_000;
/** The room auto-ends this long after the scheduled end, in case nobody calls completeSession. */
export const AUTO_END_GRACE_MS = 60_000;
/** Server-enforced silence threshold for a stuck cue — independent of whatever the client reports. */
export const STUCK_SILENCE_MS = 8_000;
/** Minimum LiveKit token TTL handed out, even if the session is nearly over. */
export const MIN_TOKEN_TTL_SECONDS = 60;

/** "within 5 min before start until the end time" (inclusive of both ends). */
export function withinJoinWindow(now: number, scheduledStartAt: number, scheduledEndAt: number): boolean {
  return now >= scheduledStartAt - JOIN_WINDOW_BEFORE_START_MS && now <= scheduledEndAt;
}

/** Seconds remaining until scheduledEndAt + the auto-end grace, floored at MIN_TOKEN_TTL_SECONDS. */
export function tokenTtlSeconds(now: number, scheduledEndAt: number): number {
  const remainingMs = scheduledEndAt + AUTO_END_GRACE_MS - now;
  return Math.max(MIN_TOKEN_TTL_SECONDS, Math.ceil(remainingMs / 1000));
}

// ---------------------------------------------------------------------------
// Script-line matching: deterministic normalized word overlap, no LLM
// ---------------------------------------------------------------------------

/** How much of the EXPECTED line's own vocabulary must appear in the transcript to count as a match. */
export const LINE_MATCH_OVERLAP_THRESHOLD = 0.5;

/**
 * True when `transcript` says enough of `lineText` to count as that line
 * being spoken — normalized token overlap (fold + tokenize, same as scoring.ts
 * uses for word matching), not an exact match, so paraphrasing close to the
 * line's own wording still counts, but an unrelated sentence doesn't.
 */
export function scriptLineMatches(transcript: string, lineText: string, threshold: number = LINE_MATCH_OVERLAP_THRESHOLD): boolean {
  const lineTokens = new Set(matchTokens(lineText));
  if (lineTokens.size === 0) return false;
  const said = new Set(matchTokens(transcript));
  let hits = 0;
  for (const token of lineTokens) if (said.has(token)) hits++;
  return hits / lineTokens.size >= threshold;
}

export type ScriptLineLike = { role: "learner" | "partner"; text: string; words: string[] };

/**
 * The index (into the full `lines` array) of the next expected LEARNER line —
 * i.e. the first "learner" line whose index is not already in `doneIndices`.
 * Partner lines are never tracked for matching (see the task's own scope).
 * `null` means every learner line is already done.
 */
export function nextLearnerLineIndex(lines: readonly ScriptLineLike[], doneIndices: ReadonlySet<number>): number | null {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.role === "learner" && !doneIndices.has(i)) return i;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Keyterms for the partner's AssemblyAI stream: the script's own vocabulary
// plus a cheap, deterministic "names" heuristic — no LLM call.
// ---------------------------------------------------------------------------

const MAX_KEYTERM_LENGTH = 50;

/**
 * The script's target-word vocabulary (already resolved, canonical words —
 * see roomScriptLineValidator) plus capitalized, non-sentence-initial tokens
 * from each line's text (a cheap stand-in for "names": a script line's own
 * first word is always capitalized regardless of whether it's a name, so it
 * is skipped; an ALL-CAPS token is skipped too, since that is more likely
 * emphasis or an acronym than a name).
 */
export function extractKeyterms(lines: readonly ScriptLineLike[], maxTerms: number = 20): string[] {
  const terms = new Set<string>();
  for (const line of lines) {
    for (const word of line.words) {
      if (word.trim().length > 0) terms.add(word.trim());
    }
    const tokens = line.text.split(/\s+/);
    for (let i = 1; i < tokens.length; i++) {
      const raw = tokens[i]!.replace(/[^\p{L}'-]/gu, "");
      if (raw.length >= 2 && /^\p{Lu}/u.test(raw) && !/^\p{Lu}+$/u.test(raw)) terms.add(raw);
    }
  }
  return [...terms].filter((term) => term.length > 0 && term.length <= MAX_KEYTERM_LENGTH).slice(0, maxTerms);
}

// ---------------------------------------------------------------------------
// Session report stats (Task C): rules first, no LLM. Pure over the saved
// turns — scripts/verify.ts exercises this without a deployment.
// ---------------------------------------------------------------------------

export type ReportTurnLike = {
  role: "learner" | "partner";
  startMs: number;
  endMs: number;
  wordsCount: number;
  targetWordsSaid: readonly string[];
};

export type RoomReportStats = {
  totalLearnerLines: number;
  linesDone: number;
  targetWordsUsed: string[];
  longestPauseMs: number;
  speakingSpeedWpm: number;
  talkSharePercent: number;
  stuckCount: number;
};

/**
 * Deterministic session stats from the saved turns:
 *   - longestPauseMs: the largest gap between one turn ending and the next
 *     starting, across the whole session (either role).
 *   - speakingSpeedWpm: the LEARNER's own words / their own speaking minutes.
 *   - talkSharePercent: the learner's speaking time as a share of total
 *     (learner + partner) speaking time.
 *   - targetWordsUsed: the distinct target words the learner actually said
 *     (deduped), across every learner turn.
 */
export function computeRoomReportStats(args: {
  turns: readonly ReportTurnLike[];
  totalLearnerLines: number;
  linesDone: number;
  stuckCount: number;
}): RoomReportStats {
  const sorted = [...args.turns].sort((a, b) => a.startMs - b.startMs);
  let longestPauseMs = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]!.startMs - sorted[i - 1]!.endMs;
    if (gap > longestPauseMs) longestPauseMs = gap;
  }

  const learnerTurns = args.turns.filter((t) => t.role === "learner");
  const learnerWords = learnerTurns.reduce((acc, t) => acc + t.wordsCount, 0);
  const learnerMs = learnerTurns.reduce((acc, t) => acc + Math.max(0, t.endMs - t.startMs), 0);
  const speakingSpeedWpm = learnerMs > 0 ? Math.round((learnerWords / (learnerMs / 60_000)) * 10) / 10 : 0;

  const partnerMs = args.turns.filter((t) => t.role === "partner").reduce((acc, t) => acc + Math.max(0, t.endMs - t.startMs), 0);
  const totalTalkMs = learnerMs + partnerMs;
  const talkSharePercent = totalTalkMs > 0 ? Math.round((learnerMs / totalTalkMs) * 1000) / 10 : 0;

  const targetWordsUsed = [...new Set(learnerTurns.flatMap((t) => t.targetWordsSaid))];

  return {
    totalLearnerLines: args.totalLearnerLines,
    linesDone: Math.min(args.linesDone, args.totalLearnerLines),
    targetWordsUsed,
    longestPauseMs: Math.max(0, longestPauseMs),
    speakingSpeedWpm,
    talkSharePercent,
    stuckCount: args.stuckCount,
  };
}

// ---------------------------------------------------------------------------
// Session report feedback (LLM Gateway, one call, in the learner's own language)
// ---------------------------------------------------------------------------

export const ROOM_REPORT_SYSTEM = `You are writing short feedback for a language learner who just finished a live speaking practice session with a conversation partner.
You are given deterministic stats about the session (never invent numbers of your own) and the scenario they practised.
Write 2-3 short, encouraging sentences: mention something they did well, and one specific thing to focus on next time. Write ONLY in the learner's own language given below — never the language they are practising. No markdown, no headings.`;

export const ROOM_REPORT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { feedback: { type: "string" } },
  required: ["feedback"],
  additionalProperties: false,
};

export type RoomReportFeedback = { feedback: string };

export function roomReportPrompt(args: {
  scenario: string;
  primaryLanguageName: string;
  stats: RoomReportStats;
}): string {
  return `Scenario practised: "${args.scenario}"
Write the feedback in: ${args.primaryLanguageName}

Session stats:
- Script lines completed: ${args.stats.linesDone} of ${args.stats.totalLearnerLines}
- Target words used: ${args.stats.targetWordsUsed.length > 0 ? args.stats.targetWordsUsed.join(", ") : "none"}
- Longest pause: ${Math.round(args.stats.longestPauseMs / 1000)} seconds
- Speaking speed: ${args.stats.speakingSpeedWpm} words/min
- Share of the conversation they spoke: ${args.stats.talkSharePercent}%
- Times they got stuck (needed the line repeated slowly): ${args.stats.stuckCount}

Return { "feedback": "<2-3 short sentences, in ${args.primaryLanguageName}>" }.`;
}

export function validateRoomReportFeedback(raw: unknown): RoomReportFeedback {
  if (typeof raw !== "object" || raw === null) throw new Error("room report feedback: expected an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.feedback !== "string" || obj.feedback.trim().length === 0) {
    throw new Error('room report feedback: "feedback" must be a non-empty string');
  }
  return { feedback: obj.feedback.trim().slice(0, 1000) };
}
