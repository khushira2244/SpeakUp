/**
 * Live streaming check: sends a local audio file to AssemblyAI's v3 streaming
 * WebSocket exactly the way the browser will — authenticated with a
 * short-lived temp token minted by the backend's `levelCheck.getStreamingToken`
 * action, never with the raw API key.
 *
 *   npx tsx scripts/test-stream.ts --file sample.wav [--model u3-rt-pro]
 *   npx tsx scripts/test-stream.ts --file sample.wav --purpose own
 *   npx tsx scripts/test-stream.ts --file sample.wav --model u3-rt-pro --language-detection
 *
 * Options
 *   --file <path>           16 kHz mono PCM16 WAV (required). Anything else is
 *                           rejected with a clear error — or converted, if
 *                           ffmpeg is already installed.
 *   --model <speech_model>  e.g. u3-rt-pro, whisper-rt, universal-3-5-pro
 *   --purpose target|own    ask the backend's getStreamConfig which model to
 *                           use for the signed-in account (ignored with --model)
 *   --language-detection    add language_detection=true to the URL
 *   --language-codes de,en  add language_codes=["de","en"] to the URL
 *   --email / --password    account used to mint the token
 *                           (default: the fixed dev account test@speakup.dev)
 *
 * Prints: the final transcript, the detected language (or that none was
 * returned), and whether word-level confidence came back, with examples.
 *
 * CAVEAT: synthetic (TTS) or studio-quality clips produce confidence values
 * that are NOT representative of real learners' speech.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
/** AssemblyAI requires each audio message to hold 50–1000 ms of audio. */
const CHUNK_MS = 100;
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000;
/** Trailing silence so the model can close the last turn on its own. */
const TRAILING_SILENCE_MS = 1_500;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Options = {
  file: string;
  model: string | null;
  purpose: "target" | "own" | null;
  languageDetection: boolean;
  languageCodes: string[] | null;
  email: string;
  password: string;
};

function usage(message?: string): never {
  if (message) console.error(`\n✗ ${message}\n`);
  console.error(
    "Usage: npx tsx scripts/test-stream.ts --file <16kHz-mono-pcm16.wav> [--model <speech_model> | --purpose target|own] [--language-detection] [--language-codes de,en]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    file: "",
    model: null,
    purpose: null,
    languageDetection: false,
    languageCodes: null,
    email: process.env.SPEAKUP_EMAIL ?? "test@speakup.dev",
    password: process.env.SPEAKUP_PASSWORD ?? "speakup-dev-fixed-password-1",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) usage(`${flag} needs a value`);
      i++;
      return next;
    };
    switch (flag) {
      case "--file":
        options.file = value();
        break;
      case "--model":
        options.model = value();
        break;
      case "--purpose": {
        const purpose = value();
        if (purpose !== "target" && purpose !== "own") usage("--purpose must be target or own");
        options.purpose = purpose;
        break;
      }
      case "--language-detection":
        options.languageDetection = true;
        break;
      case "--language-codes":
        options.languageCodes = value()
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        break;
      case "--email":
        options.email = value();
        break;
      case "--password":
        options.password = value();
        break;
      default:
        usage(`unknown option ${flag}`);
    }
  }
  if (options.file === "") usage("--file is required");
  return options;
}

// ---------------------------------------------------------------------------
// WAV handling
// ---------------------------------------------------------------------------

type WavInfo = {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Buffer;
};

function parseWav(buffer: Buffer): WavInfo | string {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return "not a RIFF/WAVE file";
  }
  let offset = 12;
  let fmt: Omit<WavInfo, "data"> | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      let audioFormat = buffer.readUInt16LE(body);
      // WAVE_FORMAT_EXTENSIBLE: the real format tag is the sub-format GUID's first 2 bytes.
      if (audioFormat === 0xfffe && size >= 26) audioFormat = buffer.readUInt16LE(body + 24);
      fmt = {
        audioFormat,
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (fmt === null) return "missing fmt chunk";
  if (data === null) return "missing data chunk";
  return { ...fmt, data };
}

function describe(info: Omit<WavInfo, "data">): string {
  return `format=${info.audioFormat === 1 ? "PCM" : info.audioFormat}, ${info.sampleRate} Hz, ${info.channels} ch, ${info.bitsPerSample}-bit`;
}

function isRequiredFormat(info: WavInfo): boolean {
  return (
    info.audioFormat === 1 &&
    info.channels === 1 &&
    info.sampleRate === SAMPLE_RATE &&
    info.bitsPerSample === 16
  );
}

function ffmpegAvailable(): boolean {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", shell: false });
  return probe.status === 0;
}

/** Returns 16 kHz mono PCM16 samples, converting with ffmpeg only if already installed. */
function loadPcm(file: string): Buffer {
  if (!existsSync(file)) usage(`file not found: ${file}`);
  const parsed = parseWav(readFileSync(file));
  if (typeof parsed !== "string" && isRequiredFormat(parsed)) {
    console.log(`  audio: ${describe(parsed)} — OK`);
    return parsed.data;
  }

  const reason = typeof parsed === "string" ? parsed : describe(parsed);
  const convertCmd = `ffmpeg -i "${file}" -ac 1 -ar 16000 -c:a pcm_s16le converted.wav`;
  if (!ffmpegAvailable()) {
    usage(
      `${file} is not 16 kHz mono PCM16 WAV (${reason}).\n  ffmpeg is not installed, so it cannot be converted automatically. Convert it yourself:\n    ${convertCmd}`,
    );
  }
  console.log(`  audio: ${reason} — converting with the installed ffmpeg`);
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "speakup-stream-")), "converted.wav");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out]);
  const converted = parseWav(readFileSync(out));
  if (typeof converted === "string" || !isRequiredFormat(converted)) {
    usage(`ffmpeg conversion did not produce 16 kHz mono PCM16 (${typeof converted === "string" ? converted : describe(converted)})`);
  }
  return converted.data;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

type TurnWord = { text?: string; confidence?: number; start?: number; end?: number; word_is_final?: boolean };
type ServerMessage = {
  type?: string;
  turn_order?: number;
  end_of_turn?: boolean;
  turn_is_formatted?: boolean;
  transcript?: string;
  utterance?: string;
  words?: TurnWord[];
  language_code?: string;
  language_confidence?: number;
  error?: string;
  error_code?: number;
  [key: string]: unknown;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function readConvexUrl(): string {
  const match = readFileSync(path.join(ROOT, ".env.local"), "utf8").match(/^CONVEX_URL=(.+)$/m);
  if (match === null || match[1] === undefined) usage("CONVEX_URL not found in .env.local");
  return match[1].trim();
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log("SpeakUp — live streaming check");
  console.log("=".repeat(60));
  console.log(`  file: ${options.file}`);

  const pcm = loadPcm(options.file);
  const audioSeconds = pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
  console.log(`  duration: ${audioSeconds.toFixed(2)} s`);

  // --- Temp token through the backend (the browser's path) -----------------
  const client = new ConvexHttpClient(readConvexUrl());
  const signIn = await client.action(api.auth.signIn, {
    provider: "password",
    params: { email: options.email, password: options.password, flow: "signIn" },
  });
  const sessionToken = signIn.tokens?.token;
  if (typeof sessionToken !== "string") usage(`could not sign in as ${options.email}`);
  client.setAuth(sessionToken);

  let model = options.model;
  if (model === null) {
    // Exactly what the browser does: ask the backend, then use its params.
    const config = await client.query(api.levelCheck.getStreamConfig, {
      purpose: options.purpose ?? "target",
    });
    model = config.connectionParams.speech_model;
    if (config.connectionParams.language_detection === "true") options.languageDetection = true;
    console.log(
      `  getStreamConfig(${config.purpose}) -> ${JSON.stringify(config.connectionParams)}, language=${config.language} (from ${config.languageSource})`,
    );
  }

  const minted = await client.action(api.levelCheck.getStreamingToken, {});
  console.log(`  temp token minted by levelCheck.getStreamingToken (expires in ${minted.expiresInSeconds}s)`);

  const params = new URLSearchParams({
    sample_rate: String(SAMPLE_RATE),
    encoding: "pcm_s16le",
    speech_model: model,
  });
  if (options.languageDetection) params.set("language_detection", "true");
  if (options.languageCodes !== null) params.set("language_codes", JSON.stringify(options.languageCodes));
  const shownUrl = `${minted.websocketUrl}?${params}&token=<temp-token>`;
  params.set("token", minted.token);
  const url = `${minted.websocketUrl}?${params}`;
  console.log(`  url: ${shownUrl}\n`);

  // --- Session ---------------------------------------------------------------
  const messages: ServerMessage[] = [];
  const turnKeys = new Set<string>();
  let begun = false;
  let closeInfo = "";

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const hardTimeout = setTimeout(() => {
      console.log("  ! timed out waiting for the session to end");
      ws.close();
    }, (audioSeconds + 45) * 1000);

    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      messages.push(msg);
      if (msg.type === "Begin") {
        begun = true;
        console.log(`  <- Begin ${JSON.stringify(msg.configuration ?? {})}`);
        void stream(ws);
      } else if (msg.type === "Turn") {
        for (const key of Object.keys(msg)) turnKeys.add(key);
        if (msg.end_of_turn) {
          console.log(
            `  <- Turn #${msg.turn_order} end_of_turn${msg.turn_is_formatted ? " (formatted)" : ""}: ${JSON.stringify(msg.transcript ?? msg.utterance ?? "")}`,
          );
        }
      } else if (msg.type === "Termination") {
        console.log(`  <- Termination ${JSON.stringify(msg)}`);
      } else if (msg.type === "Error" || msg.error !== undefined) {
        console.log(`  <- ERROR ${JSON.stringify(msg)}`);
      } else {
        console.log(`  <- ${msg.type ?? "?"} ${JSON.stringify(msg).slice(0, 200)}`);
      }
    };
    ws.onerror = () => {
      closeInfo ||= "socket error";
    };
    ws.onclose = (event) => {
      clearTimeout(hardTimeout);
      closeInfo = `code=${event.code} reason=${JSON.stringify(event.reason)}`;
      resolve();
    };
  });

  async function stream(ws: WebSocket): Promise<void> {
    // Paced at real time, the way a microphone delivers audio.
    for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length)));
      await sleep(CHUNK_MS);
    }
    const silence = Buffer.alloc(CHUNK_BYTES);
    for (let t = 0; t < TRAILING_SILENCE_MS; t += CHUNK_MS) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(silence);
      await sleep(CHUNK_MS);
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "Terminate" }));
  }

  // --- Report ----------------------------------------------------------------
  console.log(`\n  session closed: ${closeInfo}`);
  if (!begun) {
    console.log("\n✗ The session never began — see the error above.");
    process.exit(1);
  }

  // Keep the last end-of-turn message per turn (models may send an
  // unformatted final and then a formatted one).
  const finals = new Map<number, ServerMessage>();
  for (const msg of messages) {
    if (msg.type === "Turn" && msg.end_of_turn) finals.set(msg.turn_order ?? finals.size, msg);
  }
  const finalTurns = [...finals.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
  const transcript = finalTurns
    .map((m) => (m.transcript ?? m.utterance ?? "").trim())
    .filter(Boolean)
    .join(" ");

  const allTurns = messages.filter((m) => m.type === "Turn");
  const detected = [...allTurns].reverse().find((m) => typeof m.language_code === "string");
  const finalWords = finalTurns.flatMap((m) => m.words ?? []);
  const withConfidence = finalWords.filter((w) => typeof w.confidence === "number");

  console.log("\n" + "=".repeat(60));
  console.log(`MODEL:             ${model}`);
  console.log(`FINAL TRANSCRIPT:  ${transcript === "" ? "(empty)" : transcript}`);
  console.log(
    `DETECTED LANGUAGE: ${
      detected
        ? `${detected.language_code}${typeof detected.language_confidence === "number" ? ` (confidence ${detected.language_confidence.toFixed(2)})` : ""}`
        : "not returned"
    }`,
  );
  console.log(
    `WORD CONFIDENCE:   ${withConfidence.length > 0 ? `yes — ${withConfidence.length}/${finalWords.length} final words carry a confidence` : finalWords.length > 0 ? "no — words returned without confidence" : "no — no word list returned"}`,
  );
  for (const word of withConfidence.slice(0, 10)) {
    console.log(`    ${String(word.text).padEnd(16)} ${word.confidence!.toFixed(3)}`);
  }
  console.log(`TURN FIELDS SEEN:  ${[...turnKeys].sort().join(", ") || "(no Turn messages)"}`);
  console.log(
    "\nCAVEAT: synthetic or studio-recorded speech yields confidence values that are not representative of real learners.",
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
