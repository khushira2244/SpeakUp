"use client";

import Link from "next/link";
import { useState } from "react";
import { useConvexAuth } from "convex/react";
import { useI18n } from "@/i18n/provider";
import { LiveMic, type LiveMicError, type LiveMicResult, type MicState } from "@/components/live-mic/live-mic";
import { Screen } from "@/components/ui";

type LogLine = { at: string; text: string };

export function MicDevClient() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { lang, setLang } = useI18n();

  const [purpose, setPurpose] = useState<"target" | "own">("target");
  const [stopOn, setStopOn] = useState<"manual" | "first-turn">("manual");
  const [timer, setTimer] = useState(false);
  const [native, setNative] = useState(false);

  const [state, setState] = useState<MicState>("idle");
  const [live, setLive] = useState("");
  const [final, setFinal] = useState<LiveMicResult | null>(null);
  const [error, setError] = useState<LiveMicError | null>(null);
  const [info, setInfo] = useState<{ speechModel: string; sampleRate: number | null } | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [finalCalls, setFinalCalls] = useState(0);

  function push(text: string) {
    setLog((prev) => [...prev.slice(-59), { at: new Date().toISOString().slice(11, 23), text }]);
  }

  function reset() {
    setState("idle");
    setLive("");
    setFinal(null);
    setError(null);
    setInfo(null);
    setLog([]);
    setFinalCalls(0);
  }

  const mountKey = `${purpose}-${stopOn}-${timer}-${native}`;

  return (
    <Screen>
      <h1 className="text-[24px] font-bold">
        <span className="text-accent">/dev/mic</span> <span className="text-muted">LiveMic test</span>
      </h1>
      <Link href="/" data-testid="dev-back" className="mt-1 text-base text-muted underline">
        back to /
      </Link>

      {!isLoading && !isAuthenticated ? (
        <p className="mt-4 rounded-2xl border border-line p-4 text-base">
          You are signed out, so no streaming token can be minted.{" "}
          <Link href="/auth" className="text-accent underline">
            Log in first
          </Link>
          , then come back to /dev/mic.
        </p>
      ) : null}

      <fieldset className="mt-4 grid gap-3 rounded-2xl border border-line p-4 text-base">
        <legend className="px-2 text-muted">Options (changing one resets the mic)</legend>
        <Choice label="purpose" value={purpose} options={["target", "own"]} onChange={(v) => { setPurpose(v as "target" | "own"); reset(); }} />
        <Choice label="stopOn" value={stopOn} options={["manual", "first-turn"]} onChange={(v) => { setStopOn(v as "manual" | "first-turn"); reset(); }} />
        <Choice label="UI language" value={lang} options={["en", "hi"]} onChange={(v) => setLang(v as "en" | "hi")} />
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={timer} onChange={(e) => { setTimer(e.target.checked); reset(); }} />
          60 s timer + auto-stop (maxSeconds=60)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={native} onChange={(e) => { setNative(e.target.checked); reset(); }} />
          use the browser&apos;s native sample rate (tests the resampler)
        </label>
      </fieldset>

      <section className="mt-6" data-testid="dev-mic">
        <LiveMic
          key={mountKey}
          purpose={purpose}
          stopOn={stopOn}
          maxSeconds={timer ? 60 : undefined}
          transcriptLabel="Your answer"
          onStateChange={(s) => {
            setState(s);
            push(`state -> ${s}`);
          }}
          onLive={setLive}
          onFinal={(r) => {
            setFinal(r);
            setFinalCalls((n) => n + 1);
            push(`onFinal (${r.words.length} words)`);
          }}
          onError={(code) => {
            setError(code);
            push(`onError("${code}")`);
          }}
          debug={{
            nativeSampleRate: native,
            onConnection: (i) => {
              setInfo(i);
              push(`connected: ${i.speechModel} @ ${i.sampleRate} Hz`);
            },
            onEvent: (type, detail) => {
              if (type === "Turn") {
                const d = detail as { turn_order?: number; end_of_turn?: boolean; text?: string };
                push(`Turn #${d.turn_order} ${d.end_of_turn ? "FINAL" : "partial"}: ${d.text ?? ""}`);
              } else {
                push(`ws ${type}${detail && type !== "Begin" ? " " + JSON.stringify(detail).slice(0, 120) : ""}`);
              }
            },
          }}
        />
      </section>

      <section className="mt-6 grid gap-4 text-base">
        <Row label="state"><span data-testid="dev-state" className="font-mono">{state}</span></Row>
        <Row label="stream"><span data-testid="dev-info" className="font-mono">{info ? `${info.speechModel} @ ${info.sampleRate ?? "?"} Hz` : "—"}</span></Row>
        <Row label="live (partial + finals, never saved)"><span data-testid="dev-live">{live || "—"}</span></Row>
        <Row label={`FINAL transcript (onFinal calls: ${finalCalls})`}>
          <span data-testid="dev-final">{final ? final.transcript : "—"}</span>
        </Row>
        <Row label="language detected">
          <span data-testid="dev-language" className="font-mono">
            {final ? `${final.languageCode ?? "not returned"}${final.languageConfidence !== null ? ` (${final.languageConfidence.toFixed(2)})` : ""}` : "—"}
          </span>
        </Row>
        <Row label="error"><span data-testid="dev-error" className="font-mono">{error ?? "—"}</span></Row>

        <div>
          <p className="mb-2 text-muted">word timings + confidence</p>
          <table className="w-full text-left" data-testid="dev-words">
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-2">word</th>
                <th className="py-1 pr-2">confidence</th>
                <th className="py-1">start–end (ms)</th>
              </tr>
            </thead>
            <tbody>
              {final?.words.map((w, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="py-1 pr-2">{w.text}</td>
                  <td className="py-1 pr-2">
                    {w.confidence === null ? (
                      <span className="text-muted">none</span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <span className="h-2 w-16 overflow-hidden rounded bg-line">
                          <span className="block h-full bg-accent" style={{ width: `${w.confidence * 100}%` }} />
                        </span>
                        <span className="font-mono">{w.confidence.toFixed(3)}</span>
                      </span>
                    )}
                  </td>
                  <td className="py-1 font-mono">{w.start}–{w.end}</td>
                </tr>
              )) ?? (
                <tr>
                  <td colSpan={3} className="py-1 text-muted">—</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div>
          <p className="mb-2 text-muted">event log</p>
          <pre data-testid="dev-log" className="max-h-64 overflow-auto rounded-2xl border border-line bg-surface p-3 text-[13px] leading-snug whitespace-pre-wrap">
            {log.map((l) => `${l.at}  ${l.text}`).join("\n") || "—"}
          </pre>
        </div>
      </section>
    </Screen>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-muted">{label}</p>
      <div className="mt-1 break-words">{children}</div>
    </div>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-24 text-muted">{label}</span>
      {options.map((o) => (
        <label key={o} className="flex items-center gap-1">
          <input type="radio" name={label} checked={value === o} onChange={() => onChange(o)} />
          {o}
        </label>
      ))}
    </div>
  );
}
