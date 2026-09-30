/**
 * Room-script generation validation (convex/rooms.ts generateScript). Same
 * hard rule as plans.ts/labValidate.ts: the LLM only sequences and writes
 * dialogue around words the server already owns — every word a line uses is
 * constrained to an enumerated allowed list (the json_schema `enum`), never
 * free text the model invents.
 *
 * Dependency-free (no Convex imports), so this is unit-testable without a
 * deployment.
 */

import { ValidationError, asArrayOf, asNonEmptyString, asRecord } from "./validate";
import type { RoomMinutes } from "./rooms";

function fail(path: string, message: string): never {
  throw new ValidationError(`${path}: ${message}`);
}

/** How many lines a script has, scaled by session length. */
export const SCRIPT_LINE_BOUNDS: Record<RoomMinutes, { min: number; max: number }> = {
  5: { min: 4, max: 6 },
  10: { min: 6, max: 10 },
  15: { min: 8, max: 14 },
};

export function scriptLineBounds(minutes: RoomMinutes): { min: number; max: number } {
  return SCRIPT_LINE_BOUNDS[minutes];
}

const MAX_LINE_TEXT = 300;
const MAX_MEANING_TEXT = 300;

export function roomScriptJsonSchema(wordIds: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["learner", "partner"] },
            text: { type: "string" },
            meaning: { type: "string" },
            wordIds: { type: "array", items: { type: "string", enum: [...wordIds] } },
          },
          required: ["role", "text", "meaning", "wordIds"],
          additionalProperties: false,
        },
      },
    },
    required: ["lines"],
    additionalProperties: false,
  };
}

export type ValidatedScriptLine = { role: "learner" | "partner"; text: string; meaning: string; wordIds: string[] };
export type ValidatedScript = { lines: ValidatedScriptLine[] };

export function validateRoomScript(
  raw: unknown,
  opts: { wordIds: ReadonlySet<string>; minutes: RoomMinutes },
): ValidatedScript {
  const root = asRecord(raw, "script");
  const bounds = scriptLineBounds(opts.minutes);

  const lines = asArrayOf(root.lines, "script.lines", bounds, (rawItem, path): ValidatedScriptLine => {
    const obj = asRecord(rawItem, path);
    const rawRole = obj.role;
    const role: "learner" | "partner" = rawRole === "learner" || rawRole === "partner" ? rawRole : fail(`${path}.role`, `expected "learner" or "partner"`);
    const text = asNonEmptyString(obj.text, `${path}.text`, MAX_LINE_TEXT);
    const meaning = asNonEmptyString(obj.meaning, `${path}.meaning`, MAX_MEANING_TEXT);
    const wordIds = asArrayOf(obj.wordIds, `${path}.wordIds`, { min: 0, max: 20 }, (rawId, idPath) => {
      const id = asNonEmptyString(rawId, idPath, 20);
      if (!opts.wordIds.has(id)) fail(idPath, `"${id}" is not one of this goal's allowed word IDs`);
      return id;
    });
    return { role, text, meaning, wordIds };
  });

  // At least one line per role — otherwise it is not a two-person conversation.
  if (!lines.some((l) => l.role === "learner")) fail("script.lines", "no line has role \"learner\"");
  if (!lines.some((l) => l.role === "partner")) fail("script.lines", "no line has role \"partner\"");

  return { lines };
}
