"use client";

import { useCallback } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

/** Same limit the server enforces. The server is the one that actually refuses a 51st word. */
export const MAX_SAVED = 50;

export const normalizeWord = (s: string) => s.normalize("NFC").trim().toLocaleLowerCase();

export type WordEntry = { word: string; meaning: string; pronunciationHint: string | null };

export type SaveResult = "ok" | "limit" | "error";

export function errorCode(error: unknown): string | null {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: unknown } | undefined;
    return typeof data?.code === "string" ? data.code : null;
  }
  return null;
}

export function useSavedWords() {
  const list = useQuery(api.savedWords.list, {});
  const saveMutation = useMutation(api.savedWords.save);
  const removeMutation = useMutation(api.savedWords.remove);

  const findId = useCallback(
    (word: string): Id<"savedWords"> | null =>
      list?.find((w) => normalizeWord(w.word) === normalizeWord(word))?._id ?? null,
    [list],
  );

  const save = useCallback(
    async (entry: WordEntry, source: "goal" | "lookup"): Promise<SaveResult> => {
      try {
        await saveMutation({
          word: entry.word,
          meaning: entry.meaning,
          pronunciationHint: entry.pronunciationHint ?? undefined,
          source,
        });
        return "ok";
      } catch (error) {
        return errorCode(error) === "limit" ? "limit" : "error";
      }
    },
    [saveMutation],
  );

  const remove = useCallback(
    async (id: Id<"savedWords">): Promise<boolean> => {
      try {
        await removeMutation({ id });
        return true;
      } catch {
        return false;
      }
    },
    [removeMutation],
  );

  return { list, findId, save, remove };
}

export type LookupResult =
  | { ok: true; word: string; meaning: string; pronunciationHint: string | null }
  | { ok: false; reason: "not_a_word" | "too_long" | "failed" };

export function useLookup() {
  const lookupAction = useAction(api.dictionary.lookup);
  return useCallback(
    async (word: string): Promise<LookupResult> => {
      try {
        const r = await lookupAction({ word });
        return r.ok
          ? { ok: true, word: r.word, meaning: r.meaning, pronunciationHint: r.pronunciationHint }
          : { ok: false, reason: r.reason };
      } catch {
        return { ok: false, reason: "failed" };
      }
    },
    [lookupAction],
  );
}

/** For "did you say the word?": lower-case, no punctuation, ß written as ss. */
export function forMatch(s: string): string {
  return s
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function heardWord(heard: string, word: string): boolean {
  const h = ` ${forMatch(heard)} `;
  const w = forMatch(word);
  return w.length > 0 && h.includes(` ${w} `);
}
