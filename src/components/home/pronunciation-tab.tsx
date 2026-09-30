"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { PrimaryButton, Spinner } from "@/components/ui";
import { LiveMic } from "@/components/live-mic/live-mic";
import { lettersFor, type HintLang, type Letter } from "@/lib/letters";
import { ListenRow, Sheet, SpeakButton } from "./sheet";
import { WordSheet } from "./word-sheet";
import {
  MAX_SAVED,
  heardWord,
  useLookup,
  useSavedWords,
  type WordEntry,
} from "./use-saved-words";

type Saved = ReturnType<typeof useSavedWords>;

function MicGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
    </svg>
  );
}

export function PronunciationTab() {
  const { t } = useI18n();
  const data = useQuery(api.home.words, {});
  const saved = useSavedWords();

  const [practise, setPractise] = useState<WordEntry | null>(null);
  const [open, setOpen] = useState<{ entry: WordEntry; source: "goal" | "lookup" } | null>(null);
  const [adding, setAdding] = useState(false);

  if (data === undefined || saved.list === undefined) {
    return (
      <div className="mt-10 flex flex-col items-center gap-3 text-muted" role="status">
        <Spinner />
        <p className="text-base">{t("common.loading")}</p>
      </div>
    );
  }
  if (data === null) return <p className="mt-8 text-center text-base text-muted">{t("words.empty")}</p>;

  const beginner = data.level === "starting";
  const hintLang: HintLang = data.primaryLanguage;
  const savedList = saved.list;

  return (
    <div className="mt-4 grid gap-8">
      {beginner ? <LettersSection target={data.targetLanguage} hintLang={hintLang} /> : null}

      <section aria-labelledby="saved-title">
        <div className="flex items-center justify-between gap-3">
          <h3 id="saved-title" className="text-[22px] font-bold">
            {t("pron.saved.title")}
          </h3>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-4 text-base font-semibold text-accent-ink"
          >
            <span aria-hidden="true">+</span>
            {t("pron.saved.add")}
          </button>
        </div>

        {savedList.length === 0 ? (
          <div className="mt-3 flex flex-col items-center rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center">
            <span className="grid size-16 place-items-center rounded-full border border-accent/50 text-accent">
              <MicGlyph size={30} />
            </span>
            <p className="mt-4 text-[18px] font-semibold">{t("pron.saved.emptyTitle")}</p>
            <p className="mt-1 text-base text-muted">{t("pron.saved.emptyBody")}</p>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-line rounded-2xl border border-line bg-surface">
            {savedList.map((w) => {
              const entry = { word: w.word, meaning: w.meaning, pronunciationHint: w.pronunciationHint };
              return (
                <WordRow
                  key={w._id}
                  entry={entry}
                  lang={data.targetLanguage}
                  onOpen={() => setOpen({ entry, source: w.source })}
                  onPractise={() => setPractise(entry)}
                />
              );
            })}
          </ul>
        )}
        <p className="mt-2 text-base text-muted">{t("pron.saved.count", { n: savedList.length, max: MAX_SAVED })}</p>
      </section>

      {/*
       * The full goal-word dictionary lives in the Words tab (with status,
       * search and filters) — repeating it here just duplicated that list.
       * A goal word reaches this tab by being saved from its Word sheet
       * (Words tab or a lookup here), which is what "saved words" above is.
       */}

      {practise ? <PracticeSheet entry={practise} target={data.targetLanguage} onClose={() => setPractise(null)} /> : null}
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
      {adding ? <AddWordSheet target={data.targetLanguage} saved={saved} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

/** Letter sounds for absolute beginners: a grid of letters, each opening a sheet with how it sounds. */
export function LettersSection({ target, hintLang }: { target: "en" | "de"; hintLang: HintLang }) {
  const { t } = useI18n();
  const [letter, setLetter] = useState<Letter | null>(null);
  return (
    <section aria-labelledby="letters-title">
      <h3 id="letters-title" className="text-[22px] font-bold">
        {t("pron.letters.title")}
      </h3>
      <p className="mt-1 text-base text-muted">{t("pron.letters.sub")}</p>
      <ul className="mt-3 grid grid-cols-4 gap-2">
        {lettersFor(target).map((l) => (
          <li key={l.letter}>
            <button
              type="button"
              onClick={() => setLetter(l)}
              className="flex h-[76px] w-full flex-col items-center justify-center rounded-2xl border border-line bg-surface px-1 select-none hover:border-accent"
            >
              <span className="text-[24px] leading-none font-bold">{l.letter}</span>
              <span className="mt-1 max-w-full truncate text-[14px] text-muted">{l.hints[hintLang] ?? l.hints.en ?? ""}</span>
            </button>
          </li>
        ))}
      </ul>
      {letter ? <LetterSheet letter={letter} hintLang={hintLang} target={target} onClose={() => setLetter(null)} /> : null}
    </section>
  );
}

function WordRow({
  entry,
  lang,
  onOpen,
  onPractise,
}: {
  entry: WordEntry;
  lang: "en" | "de";
  onOpen: () => void;
  onPractise: () => void;
}) {
  const { t } = useI18n();
  return (
    <li className="flex items-center">
      <button type="button" onClick={onOpen} className="flex min-h-16 min-w-0 flex-1 flex-col justify-center px-4 py-3 text-left">
        <span className="text-[18px] leading-snug font-semibold break-words">{entry.word}</span>
        {entry.pronunciationHint ? <span className="text-base text-muted">{entry.pronunciationHint}</span> : null}
        <span className="text-base break-words text-muted">{entry.meaning}</span>
      </button>
      <SpeakButton text={entry.word} lang={lang} label={`${t("sheet.listen")}: ${entry.word}`} />
      <button
        type="button"
        aria-label={`${t("pron.practise.mic")}: ${entry.word}`}
        onClick={onPractise}
        className="mr-1 grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-accent"
      >
        <MicGlyph />
      </button>
    </li>
  );
}

function LetterSheet({
  letter,
  hintLang,
  target,
  onClose,
}: {
  letter: Letter;
  hintLang: HintLang;
  target: "en" | "de";
  onClose: () => void;
}) {
  const { t } = useI18n();
  const hint = letter.hints[hintLang] ?? letter.hints.en;
  const note = letter.notes?.[hintLang] ?? letter.notes?.en;
  return (
    <Sheet title={letter.letter} onClose={onClose}>
      <p className="mt-1 text-base text-muted">{t("pron.letters.soundsLike")}</p>
      {hint ? <p className="text-[28px] leading-tight font-bold">{hint}</p> : null}
      {note ? <p className="mt-2 text-base text-muted">{note}</p> : null}
      <ListenRow text={letter.speak} lang={target} />
      <div className="mt-5">
        <PrimaryButton type="button" onClick={onClose}>
          {t("sheet.close")}
        </PrimaryButton>
      </div>
    </Sheet>
  );
}

/** Say the word into the mic and see whether it was heard. Nothing is scored or saved. */
function PracticeSheet({ entry, target, onClose }: { entry: WordEntry; target: "en" | "de"; onClose: () => void }) {
  const { t } = useI18n();
  const [heard, setHeard] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const right = heard !== null && heardWord(heard, entry.word);

  return (
    <Sheet title={entry.word} onClose={onClose}>
      {entry.pronunciationHint ? <p className="mt-2 text-[20px] text-muted">{entry.pronunciationHint}</p> : null}
      <p className="mt-2 text-[20px]">{entry.meaning}</p>
      <ListenRow text={entry.word} lang={target} />
      <div className="mt-6">
        <LiveMic
          key={round}
          purpose="target"
          stopOn="first-turn"
          settleMs={300}
          idleText={t("lc.word.tap")}
          listeningSubText={t("lc.word.speakNow")}
          doneTitle={heard === null ? t("lc.word.got") : right ? t("pron.practise.right") : t("pron.practise.heard", { heard })}
          onFinal={(r) => setHeard(r.transcript)}
        />
      </div>
      {heard !== null && !right ? (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => {
              setHeard(null);
              setRound((n) => n + 1);
            }}
            className="h-11 rounded-xl border border-line-strong px-5 text-base font-semibold"
          >
            {t("pron.practise.again")}
          </button>
        </div>
      ) : null}
      <div className="mt-5">
        <PrimaryButton type="button" onClick={onClose}>
          {t("sheet.close")}
        </PrimaryButton>
      </div>
    </Sheet>
  );
}

/** Type or speak a word, look it up, and save it. */
function AddWordSheet({ target, saved, onClose }: { target: "en" | "de"; saved: Saved; onClose: () => void }) {
  const { t } = useI18n();
  const lookup = useLookup();
  const [text, setText] = useState("");
  const [live, setLive] = useState("");
  const [listening, setListening] = useState(false);
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState<WordEntry | null>(null);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [saving, setSaving] = useState(false);

  const shown = listening && live ? live : text;
  const count = saved.list?.length ?? 0;
  const already = result ? saved.findId(result.word) !== null : false;

  async function onLookup() {
    const word = shown.trim();
    if (word.length === 0 || looking) return;
    setLooking(true);
    setProblem(null);
    setResult(null);
    const r = await lookup(word);
    setLooking(false);
    if (r.ok) setResult({ word: r.word, meaning: r.meaning, pronunciationHint: r.pronunciationHint });
    else setProblem(r.reason === "not_a_word" ? "words.notFound" : "words.lookupFailed");
  }

  async function onSave() {
    if (!result || saving) return;
    setSaving(true);
    setProblem(null);
    const r = await saved.save(result, "lookup");
    setSaving(false);
    if (r === "ok") onClose();
    else setProblem(r === "limit" ? "sheet.limit" : "setup.saveFailed");
  }

  return (
    <Sheet title={t("pron.add.title")} onClose={onClose}>
      <label htmlFor="add-word" className="sr-only">
        {t("pron.add.title")}
      </label>
      <input
        id="add-word"
        value={shown}
        readOnly={listening}
        onChange={(e) => {
          setText(e.target.value);
          setResult(null);
          setProblem(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void onLookup();
        }}
        maxLength={40}
        placeholder={t("pron.add.placeholder")}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="mt-4 h-14 w-full rounded-2xl border border-line bg-bg px-4 text-[18px] text-fg placeholder:text-placeholder focus:border-accent focus:ring-2 focus:ring-accent/40 focus:outline-none"
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <LiveMic
          variant="compact"
          purpose="target"
          maxSeconds={15}
          onStateChange={(s) => {
            setListening(s === "listening");
            if (s !== "listening") setLive("");
          }}
          onLive={setLive}
          onFinal={(r) => {
            setText(r.transcript.replace(/[.,!?]+$/g, "").trim().slice(0, 40));
            setResult(null);
            setProblem(null);
          }}
        />
        <button
          type="button"
          onClick={() => void onLookup()}
          disabled={looking || listening || shown.trim().length === 0}
          className="ml-auto inline-flex min-h-11 items-center gap-2 rounded-full border border-accent px-5 text-base font-semibold text-accent disabled:opacity-50"
        >
          {looking ? <Spinner /> : null}
          {looking ? t("words.lookingUp") : t("pron.add.lookup")}
        </button>
      </div>

      {result ? (
        <section aria-label={t("pron.add.result")} className="mt-5 rounded-2xl border border-line bg-bg p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[22px] leading-tight font-bold break-words">{result.word}</p>
              {result.pronunciationHint ? <p className="text-base text-muted">{result.pronunciationHint}</p> : null}
              <p className="text-base break-words text-muted">{result.meaning}</p>
            </div>
            <SpeakButton text={result.word} lang={target} label={`${t("sheet.listen")}: ${result.word}`} />
          </div>
        </section>
      ) : null}

      {problem ? (
        <p role="alert" className="mt-3 text-base text-danger">
          {problem === "sheet.limit" ? t("sheet.limit", { n: MAX_SAVED }) : t(problem, { lang: t(`langname.${target}` as MessageKey) })}
        </p>
      ) : null}

      <div className="mt-5">
        <PrimaryButton type="button" busy={saving} disabled={!result || already} onClick={() => void onSave()}>
          {already ? t("sheet.saved") : t("pron.add.save")}
        </PrimaryButton>
        <p className="mt-2 text-center text-base text-muted">{t("pron.saved.count", { n: count, max: MAX_SAVED })}</p>
      </div>
    </Sheet>
  );
}

