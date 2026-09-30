"use client";

import { useSyncExternalStore } from "react";

export type TargetLang = "en" | "de";
export type GoalType =
  | "daily_life"
  | "doctor"
  | "job_interview"
  | "work"
  | "travel"
  | "teacher"
  | "custom";
export type Deadline = "today" | "this_week" | "2_4_weeks" | "1_3_months" | "none";
export type Minutes = 5 | 15 | 30 | 45;

export const GOAL_TYPES: readonly GoalType[] = [
  "daily_life",
  "doctor",
  "job_interview",
  "work",
  "travel",
  "teacher",
  "custom",
];
export const DEADLINES: readonly Deadline[] = ["today", "this_week", "2_4_weeks", "1_3_months", "none"];
export const MINUTES: readonly Minutes[] = [5, 15, 30, 45];

/** What the setup screens have collected so far; survives back navigation and reloads. */
export type SetupDraft = {
  targetLanguage: TargetLang | null;
  goalType: GoalType | null;
  goalText: string;
  deadline: Deadline | null;
  minutes: Minutes | null;
};

export const MAX_GOAL_CHARS = 200;

const EMPTY: SetupDraft = {
  targetLanguage: null,
  goalType: null,
  goalText: "",
  deadline: null,
  minutes: null,
};

const KEY = "speakup.setup";
const listeners = new Set<() => void>();
let current: SetupDraft | null = null;

// Storage is untrusted input: keep only values we recognise.
function parse(raw: string | null): SetupDraft {
  if (raw === null) return EMPTY;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      targetLanguage: data.targetLanguage === "en" || data.targetLanguage === "de" ? data.targetLanguage : null,
      goalType: GOAL_TYPES.find((g) => g === data.goalType) ?? null,
      goalText: typeof data.goalText === "string" ? data.goalText.slice(0, MAX_GOAL_CHARS) : "",
      deadline: DEADLINES.find((d) => d === data.deadline) ?? null,
      minutes: MINUTES.find((m) => m === data.minutes) ?? null,
    };
  } catch {
    return EMPTY;
  }
}

function load(): SetupDraft {
  try {
    return parse(window.sessionStorage.getItem(KEY));
  } catch {
    return EMPTY;
  }
}

function getSnapshot(): SetupDraft {
  current ??= load();
  return current;
}

function set(next: SetupDraft): void {
  current = next;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the in-memory copy still works for this session
  }
  listeners.forEach((l) => l());
}

export function updateDraft(patch: Partial<SetupDraft>): void {
  set({ ...getSnapshot(), ...patch });
}

export function clearDraft(): void {
  set(EMPTY);
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function useSetupDraft(): SetupDraft {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

/** false during server render and the hydration pass, true afterwards. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
}
