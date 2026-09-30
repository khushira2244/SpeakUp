"use client";

import { useCallback, useEffect, useState } from "react";

export type SpeechLang = "en" | "de" | "hi" | "te";

const BCP47: Record<SpeechLang, string> = { en: "en-US", de: "de-DE", hi: "hi-IN", te: "te-IN" };

/**
 * Plays text with the phone/browser's own voice (free, works offline). Voices
 * load a moment after the page does, and some devices have no voice for a
 * language: `hasVoice` lets the screen say so instead of staying silent.
 */
export function useSpeech() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    setSupported(true);
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  const hasVoice = useCallback(
    (lang: SpeechLang) => voices.some((v) => v.lang.toLowerCase().startsWith(lang)),
    [voices],
  );

  const speak = useCallback(
    (text: string, lang: SpeechLang, slow = false, onEnd?: () => void) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        onEnd?.();
        return;
      }
      const synth = window.speechSynthesis;
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = BCP47[lang];
      const voice = voices.find((v) => v.lang.toLowerCase().startsWith(lang));
      if (voice) utterance.voice = voice;
      utterance.rate = slow ? 0.55 : 0.95;
      if (onEnd) {
        // "end" fires on a natural finish; "error" (e.g. cancelled by the next speak()) must still resolve the caller's wait.
        utterance.onend = () => onEnd();
        utterance.onerror = () => onEnd();
      }
      synth.speak(utterance);
    },
    [voices],
  );

  const stop = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  // `ready` turns true once the device has reported its voices, so a screen does not warn too early.
  return { speak, stop, hasVoice, supported, ready: voices.length > 0 };
}
