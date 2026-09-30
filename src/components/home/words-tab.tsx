"use client";

import { useEffect, useMemo, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { Spinner, cx } from "@/components/ui";
import { SpeakButton } from "./sheet";
import { WordSheet } from "./word-sheet";
import { normalizeWord, useLookup, useSavedWords, type WordEntry } from "./use-saved-words";

type WordsData = NonNullable<FunctionReturnType<typeof api.home.words>>;
type WordRow = WordsData["words"][number];
export type WordStatus = WordRow["status"];

export const STATUS_DOT: Record<WordStatus, string> = {
  canUse: "bg-[#3ddc97]",
  practising: "bg-[#ffc247]",
  notYet: "bg-[#8a99a2]",
};

export const STATUS_LABEL: Record<WordStatus, MessageKey> = {
  canUse: "lc.result.canUse",
  practising: "lc.result.practising",
  notYet: "lc.result.notYet",
};

const STATUSES: readonly WordStatus[] = ["canUse", "practising", "notYet"];
/** How many rows a section (or the search results list) reveals at a time. */
const PAGE_SIZE = 15;

type Open = { entry: WordEntry; source: "goal" | "lookup" };

function WordListRow({ w, lang, onOpen }: { w: WordRow; lang: "en" | "de"; onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <li className="flex items-center">
      <button type="button" onClick={onOpen} className="flex min-h-16 min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left">
        <span
          role="img"
          aria-label={t(STATUS_LABEL[w.status])}
          className={cx("size-3 shrink-0 rounded-full", STATUS_DOT[w.status])}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[18px] leading-snug font-semibold break-words">{w.word}</span>
          {w.pronunciationHint ? <span className="block text-base text-muted">{w.pronunciationHint}</span> : null}
        </span>
        <span className="max-w-[40%] text-right text-base break-words text-muted">{w.meaning}</span>
      </button>
      <SpeakButton text={w.word} lang={lang} label={`${t("sheet.listen")}: ${w.word}`} />
    </li>
  );
}

/** One collapsible status group. Closed by default so 40 words don't all render at once. */
function StatusSection({
  status,
  items,
  expanded,
  onToggle,
  shownCount,
  onShowMore,
  onOpenWord,
  lang,
}: {
  status: WordStatus;
  items: readonly WordRow[];
  expanded: boolean;
  onToggle: () => void;
  shownCount: number;
  onShowMore: () => void;
  onOpenWord: (w: WordRow) => void;
  lang: "en" | "de";
}) {
  const { t } = useI18n();
  const count = items.length;
  const remaining = count - shownCount;
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-line bg-surface">
      <button
        type="button"
        onClick={onToggle}
        disabled={count === 0}
        aria-expanded={expanded}
        className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left disabled:opacity-50"
      >
        <span aria-hidden="true" className={cx("size-3 shrink-0 rounded-full", STATUS_DOT[status])} />
        <span className="min-w-0 flex-1 text-[17px] font-semibold">{t(STATUS_LABEL[status])}</span>
        <span className="text-base text-muted">{count}</span>
        {count > 0 ? (
          <span aria-hidden="true" className={cx("text-muted transition-transform", expanded && "rotate-180")}>
            ▾
          </span>
        ) : null}
      </button>
      {expanded && count > 0 ? (
        <div className="border-t border-line">
          <ul className="divide-y divide-line">
            {items.slice(0, shownCount).map((w) => (
              <WordListRow key={w.word} w={w} lang={lang} onOpen={() => onOpenWord(w)} />
            ))}
          </ul>
          {remaining > 0 ? (
            <button
              type="button"
              onClick={onShowMore}
              className="flex min-h-12 w-full items-center justify-center border-t border-line text-base font-semibold text-accent hover:bg-surface-2"
            >
              {t("words.showMore", { n: Math.min(PAGE_SIZE, remaining) })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function WordsTab() {
  const { t } = useI18n();
  const data = useQuery(api.home.words, {});
  const saved = useSavedWords();
  const lookup = useLookup();

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Open | null>(null);
  const [looking, setLooking] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  // Accordion: at most one status section open at a time, so 40 words never render at once.
  const [expanded, setExpanded] = useState<WordStatus | null>(null);
  const [shown, setShown] = useState<Record<WordStatus, number>>({
    canUse: PAGE_SIZE,
    practising: PAGE_SIZE,
    notYet: PAGE_SIZE,
  });
  const [searchShown, setSearchShown] = useState(PAGE_SIZE);

  const words = data?.words ?? [];
  const q = normalizeWord(query);

  useEffect(() => setSearchShown(PAGE_SIZE), [q]);

  const grouped = useMemo(() => {
    const byStatus: Record<WordStatus, WordRow[]> = { canUse: [], practising: [], notYet: [] };
    for (const w of words) byStatus[w.status].push(w);
    return byStatus;
  }, [words]);

  const searchResults = useMemo(
    () =>
      q === ""
        ? []
        : words.filter((w) => normalizeWord(w.word).includes(q) || normalizeWord(w.meaning).includes(q)),
    [words, q],
  );

  function toggleSection(s: WordStatus) {
    setExpanded((prev) => (prev === s ? null : s));
    setShown((prev) => ({ ...prev, [s]: PAGE_SIZE }));
  }

  function openWord(w: WordRow) {
    setOpen({ entry: { word: w.word, meaning: w.meaning, pronunciationHint: w.pronunciationHint }, source: "goal" });
  }

  if (data === undefined) {
    return (
      <div className="mt-10 flex flex-col items-center gap-3 text-muted" role="status">
        <Spinner />
        <p className="text-base">{t("common.loading")}</p>
      </div>
    );
  }
  if (data === null) return <p className="mt-8 text-center text-base text-muted">{t("words.empty")}</p>;

  const exact = words.some((w) => normalizeWord(w.word) === q);
  const canLookup = q.length >= 2 && !exact;

  async function onLookup() {
    if (looking) return;
    setLooking(true);
    setProblem(null);
    const r = await lookup(query.trim());
    setLooking(false);
    if (r.ok) {
      setOpen({ entry: { word: r.word, meaning: r.meaning, pronunciationHint: r.pronunciationHint }, source: "lookup" });
    } else {
      setProblem(r.reason === "not_a_word" ? "words.notFound" : "words.lookupFailed");
    }
  }

  return (
    <div className="mt-4">
      <div className="grid grid-cols-3 gap-2">
        {STATUSES.map((s) => (
          <div key={s} className="rounded-2xl border border-line bg-surface px-3 py-3">
            <p className="flex items-center gap-2 text-base text-muted">
              <span aria-hidden="true" className={cx("size-3 shrink-0 rounded-full", STATUS_DOT[s])} />
              <span className="min-w-0 break-words">{t(STATUS_LABEL[s])}</span>
            </p>
            <p className="mt-1 text-[24px] leading-none font-bold">{data.counts[s]}</p>
          </div>
        ))}
      </div>

      <label className="sr-only" htmlFor="word-search">
        {t("words.search")}
      </label>
      <input
        id="word-search"
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setProblem(null);
        }}
        placeholder={t("words.search")}
        autoComplete="off"
        spellCheck={false}
        className="mt-4 h-12 w-full rounded-2xl border border-line bg-surface px-4 text-base text-fg placeholder:text-placeholder focus:border-accent focus:ring-2 focus:ring-accent/40 focus:outline-none"
      />

      {canLookup ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => void onLookup()}
            disabled={looking}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-accent px-4 text-base font-semibold text-accent disabled:opacity-60"
          >
            {looking ? <Spinner /> : null}
            {looking ? t("words.lookingUp") : t("words.lookup", { word: query.trim() })}
          </button>
          {problem ? (
            <p role="alert" className="mt-2 text-base text-danger">
              {t(problem)}
            </p>
          ) : null}
        </div>
      ) : null}

      {q !== "" ? (
        // Searching cuts across all three statuses, so show one flat, paginated list instead of the accordion.
        searchResults.length === 0 && !canLookup ? (
          <p className="mt-6 text-center text-base text-muted">{t("words.empty")}</p>
        ) : (
          <>
            <ul className="mt-3 divide-y divide-line rounded-2xl border border-line bg-surface">
              {searchResults.slice(0, searchShown).map((w) => (
                <WordListRow key={w.word} w={w} lang={data.targetLanguage} onOpen={() => openWord(w)} />
              ))}
            </ul>
            {searchShown < searchResults.length ? (
              <button
                type="button"
                onClick={() => setSearchShown((n) => n + PAGE_SIZE)}
                className="mt-2 flex min-h-12 w-full items-center justify-center text-base font-semibold text-accent hover:bg-surface-2"
              >
                {t("words.showMore", { n: Math.min(PAGE_SIZE, searchResults.length - searchShown) })}
              </button>
            ) : null}
          </>
        )
      ) : (
        <div role="group" aria-label={t("home.tab.words")}>
          {STATUSES.map((s) => (
            <StatusSection
              key={s}
              status={s}
              items={grouped[s]}
              expanded={expanded === s}
              onToggle={() => toggleSection(s)}
              shownCount={shown[s]}
              onShowMore={() => setShown((prev) => ({ ...prev, [s]: prev[s] + PAGE_SIZE }))}
              onOpenWord={openWord}
              lang={data.targetLanguage}
            />
          ))}
        </div>
      )}

      {open ? (
        <WordSheet
          entry={open.entry}
          targetLang={data.targetLanguage}
          savedId={saved.findId(open.entry.word)}
          onSave={() => saved.save(open.entry, open.source)}
          onRemove={saved.remove}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
