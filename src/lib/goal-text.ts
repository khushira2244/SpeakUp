import type { GoalType } from "./setup-draft";

/**
 * What is sent to the backend as `goalText` for a preset goal. It is prompt
 * input for the word generator, so it stays English whatever the UI language.
 */
export const PRESET_GOAL_TEXT: Record<Exclude<GoalType, "custom">, string> = {
  daily_life: "Talk confidently in daily life",
  doctor: "Talk to a doctor",
  job_interview: "Job interview",
  work: "Communicate at work",
  travel: "Travel",
  teacher: "Speak to my teacher",
};
