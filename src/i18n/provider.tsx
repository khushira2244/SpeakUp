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
  LANG_COOKIE,
  isSupportedLang,
  type LangCode,
  type MessageKey,
} from "./messages";

const STORAGE_KEY = "speakup.lang";
const CHANGE_EVENT = "speakup:lang-change";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// The cookie is what the SERVER reads to render the first paint in the right
// language; localStorage is kept as a fallback (older visits) and both are
// tried defensively — private mode or blocked storage must never break rendering.
function readCookieLang(): LangCode | null {
  try {
    for (const part of document.cookie.split("; ")) {
      const [name, value] = part.split("=");
      if (name === LANG_COOKIE && isSupportedLang(value)) return value;
    }
  } catch {
    // cookies unavailable
  }
  return null;
}

function readStoredLang(): LangCode | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isSupportedLang(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeCookie(code: LangCode): void {
  try {
    document.cookie = `${LANG_COOKIE}=${code}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
  } catch {
    // cookies unavailable
  }
}

// In-memory fallback so the choice still applies for this session even when
// cookies and localStorage are both unavailable.
let memoryLang: LangCode | null = null;

function getSnapshot(): LangCode {
  return memoryLang ?? readCookieLang() ?? readStoredLang() ?? DEFAULT_LANG;
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

/**
 * `initialLang` is what the server rendered (read from the language cookie),
 * so hydration starts from the same language and nothing flashes.
 */
export function I18nProvider({
  children,
  initialLang,
}: {
  children: ReactNode;
  initialLang: LangCode;
}) {
  const getServerSnapshot = useCallback(() => initialLang, [initialLang]);
  const lang = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setLang = useCallback((code: LangCode) => {
    memoryLang = code;
    writeCookie(code);
    try {
      window.localStorage.setItem(STORAGE_KEY, code);
    } catch {
      // ignored: the cookie / memoryLang keep the choice
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    // Older visits only stored the language in localStorage: give the server a
    // cookie from now on so the next load is already correct.
    if (readCookieLang() !== lang) writeCookie(lang);
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
