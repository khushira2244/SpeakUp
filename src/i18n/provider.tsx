"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  DEFAULT_LANG,
  DICTIONARIES,
  isSupportedLang,
  type LangCode,
  type MessageKey,
} from "./messages";

const STORAGE_KEY = "speakup.lang";
const CHANGE_EVENT = "speakup:lang-change";

// localStorage can throw (private mode, blocked site data) — never let that
// break rendering; fall back to the default language.
function readStoredLang(): LangCode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isSupportedLang(stored) ? stored : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

// In-memory fallback so the choice still applies for this session even when
// localStorage is unavailable.
let memoryLang: LangCode | null = null;

function getSnapshot(): LangCode {
  return memoryLang ?? readStoredLang();
}

function getServerSnapshot(): LangCode {
  return DEFAULT_LANG;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

type Vars = Record<string, string | number>;

type I18nValue = {
  lang: LangCode;
  setLang: (code: LangCode) => void;
  t: (key: MessageKey, vars?: Vars) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const lang = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setLang = useCallback((code: LangCode) => {
    memoryLang = code;
    try {
      window.localStorage.setItem(STORAGE_KEY, code);
    } catch {
      // ignored: memoryLang keeps the choice for this session
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value = useMemo<I18nValue>(() => {
    const dict = DICTIONARIES[lang];
    const t = (key: MessageKey, vars?: Vars): string => {
      const template = dict[key];
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
        name in vars ? String(vars[name]) : whole,
      );
    };
    return { lang, setLang, t };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (ctx === null) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
