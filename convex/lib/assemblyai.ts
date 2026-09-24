/**
 * AssemblyAI wrapper: short-lived streaming-token minting + pre-recorded
 * (async) transcription with automatic language detection.
 *
 * SECURITY: ASSEMBLYAI_API_KEY is read from the deployment env and is used
 * only inside Convex actions. It never leaves the server. The browser only
 * ever receives a short-lived temporary token from `createStreamingToken`.
 *
 * Endpoints verified against the current AssemblyAI docs (Universal Streaming
 * v3 + pre-recorded v2), not from memory:
 *   - GET  https://streaming.assemblyai.com/v3/token?expires_in_seconds=N
 *          header: `Authorization: <api key>`  ->  { token, expires_in_seconds }
 *          `expires_in_seconds` must be 1..600 (token redemption window).
 *          `max_session_duration_seconds` must be 60..10800.
 *   - wss://streaming.assemblyai.com/v3/ws?token=<token>&sample_rate=16000
 *   - POST https://api.assemblyai.com/v2/upload          (raw audio bytes)
 *   - POST https://api.assemblyai.com/v2/transcript      ({ audio_url, language_detection })
 *   - GET  https://api.assemblyai.com/v2/transcript/{id} (poll until completed)
 *
 * Runs in the default Convex V8 runtime (`fetch` is built in).
 */

const STREAMING_TOKEN_URL = "https://streaming.assemblyai.com/v3/token";
const API_BASE = "https://api.assemblyai.com/v2";

/** The URL the browser opens. Exposed so the client never has to hardcode it. */
export const STREAMING_WEBSOCKET_URL = "wss://streaming.assemblyai.com/v3/ws";

/**
 * Shortest sensible redemption window. The token only has to survive the round
 * trip from this action to the browser and the WebSocket handshake.
 */
export const DEFAULT_TOKEN_EXPIRY_SECONDS = 60;
/** Cap a single level-check speaking session at 10 minutes. */
export const DEFAULT_MAX_SESSION_SECONDS = 600;

export const TOKEN_EXPIRY_MIN = 1;
export const TOKEN_EXPIRY_MAX = 600;
export const MAX_SESSION_MIN = 60;
export const MAX_SESSION_MAX = 10800;

export class AssemblyAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyAiError";
  }
}

export class AssemblyAiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyAiConfigError";
  }
}

function readApiKey(): string {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new AssemblyAiConfigError(
      "ASSEMBLYAI_API_KEY is not set on this Convex deployment. Set it with: npx convex env set ASSEMBLYAI_API_KEY <key>",
    );
  }
  return key.trim();
}

export function isAssemblyAiConfigured(): boolean {
  const key = process.env.ASSEMBLYAI_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

async function readErrorBody(response: Response): Promise<string> {
  const body = await response.text().catch(() => "<unreadable body>");
  return body.slice(0, 500);
}

// ---------------------------------------------------------------------------
// Streaming: temporary token
// ---------------------------------------------------------------------------

export type StreamingToken = {
  token: string;
  expiresInSeconds: number;
  websocketUrl: string;
};

/**
 * Mints a short-lived AssemblyAI streaming token. This is the ONLY AssemblyAI
 * credential that is ever allowed to reach the browser.
 */
export async function createStreamingToken(args?: {
  expiresInSeconds?: number;
  maxSessionDurationSeconds?: number;
  timeoutMs?: number;
}): Promise<StreamingToken> {
  const apiKey = readApiKey();
  const expiresInSeconds = clampInt(
    args?.expiresInSeconds ?? DEFAULT_TOKEN_EXPIRY_SECONDS,
    TOKEN_EXPIRY_MIN,
    TOKEN_EXPIRY_MAX,
  );
  const maxSessionDurationSeconds = clampInt(
    args?.maxSessionDurationSeconds ?? DEFAULT_MAX_SESSION_SECONDS,
    MAX_SESSION_MIN,
    MAX_SESSION_MAX,
  );

  const url = new URL(STREAMING_TOKEN_URL);
  url.searchParams.set("expires_in_seconds", String(expiresInSeconds));
  url.searchParams.set(
    "max_session_duration_seconds",
    String(maxSessionDurationSeconds),
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args?.timeoutMs ?? 15_000);
  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: apiKey },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new AssemblyAiError(
        `Streaming token request failed: ${response.status} ${response.statusText} ${await readErrorBody(response)}`,
      );
    }
    const payload = (await response.json()) as {
      token?: unknown;
      expires_in_seconds?: unknown;
    };
    if (typeof payload.token !== "string" || payload.token.length === 0) {
      throw new AssemblyAiError("Streaming token response did not contain a token");
    }
    return {
      token: payload.token,
      expiresInSeconds:
        typeof payload.expires_in_seconds === "number"
          ? payload.expires_in_seconds
          : expiresInSeconds,
      websocketUrl: STREAMING_WEBSOCKET_URL,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Pre-recorded (async) transcription with language detection
// ---------------------------------------------------------------------------

export type TranscriptWord = {
  text: string;
  confidence: number;
  start: number;
  end: number;
};

export type RecordedTranscription = {
  transcript: string;
  words: TranscriptWord[];
  languageDetected: string | null;
};

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadAudio(apiKey: string, audio: Blob): Promise<string> {
  const response = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: {
      authorization: apiKey,
      "content-type": "application/octet-stream",
    },
    body: audio,
  });
  if (!response.ok) {
    throw new AssemblyAiError(
      `Audio upload failed: ${response.status} ${response.statusText} ${await readErrorBody(response)}`,
    );
  }
  const payload = (await response.json()) as { upload_url?: unknown };
  if (typeof payload.upload_url !== "string") {
    throw new AssemblyAiError("Upload response did not contain an upload_url");
  }
  return payload.upload_url;
}

type TranscriptPayload = {
  id?: unknown;
  status?: unknown;
  text?: unknown;
  error?: unknown;
  language_code?: unknown;
  words?: unknown;
};

function normalizeWords(raw: unknown): TranscriptWord[] {
  if (!Array.isArray(raw)) return [];
  const words: TranscriptWord[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const word = item as Record<string, unknown>;
    if (typeof word.text !== "string") continue;
    words.push({
      text: word.text,
      confidence: typeof word.confidence === "number" ? word.confidence : 0,
      start: typeof word.start === "number" ? word.start : 0,
      end: typeof word.end === "number" ? word.end : 0,
    });
  }
  return words;
}

/**
 * Transcribes an audio blob with automatic language detection enabled.
 * Used for level-check answers the learner gives in their native language.
 */
export async function transcribeRecordedAudio(
  audio: Blob,
): Promise<RecordedTranscription> {
  const apiKey = readApiKey();
  const audioUrl = await uploadAudio(apiKey, audio);

  const createResponse = await fetch(`${API_BASE}/transcript`, {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      audio_url: audioUrl,
      // Automatic language identification: the learner may answer in Hindi,
      // Bengali, English, ... and we record whatever came back.
      language_detection: true,
    }),
  });
  if (!createResponse.ok) {
    throw new AssemblyAiError(
      `Transcript request failed: ${createResponse.status} ${createResponse.statusText} ${await readErrorBody(createResponse)}`,
    );
  }
  const created = (await createResponse.json()) as TranscriptPayload;
  if (typeof created.id !== "string") {
    throw new AssemblyAiError("Transcript response did not contain an id");
  }
  const transcriptId = created.id;

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pollResponse = await fetch(`${API_BASE}/transcript/${transcriptId}`, {
      method: "GET",
      headers: { authorization: apiKey },
    });
    if (!pollResponse.ok) {
      throw new AssemblyAiError(
        `Transcript poll failed: ${pollResponse.status} ${pollResponse.statusText} ${await readErrorBody(pollResponse)}`,
      );
    }
    const payload = (await pollResponse.json()) as TranscriptPayload;

    if (payload.status === "completed") {
      return {
        transcript: typeof payload.text === "string" ? payload.text : "",
        words: normalizeWords(payload.words),
        languageDetected:
          typeof payload.language_code === "string" ? payload.language_code : null,
      };
    }
    if (payload.status === "error") {
      throw new AssemblyAiError(
        `Transcription failed: ${typeof payload.error === "string" ? payload.error : "unknown error"}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new AssemblyAiError(
    `Transcription timed out after ${POLL_TIMEOUT_MS / 1000}s (transcript ${transcriptId})`,
  );
}
