/**
 * One microphone -> AssemblyAI streaming session. Framework-free so the
 * cleanup rules are easy to audit:
 *
 *  - The browser only ever holds a short-lived temp token (minted by Convex);
 *    the AssemblyAI API key never reaches it.
 *  - stop() releases the microphone immediately, sends `Terminate`, waits
 *    briefly for the final turn, then closes the socket. dispose() (unmount)
 *    does the same without waiting.
 *
 * Protocol (checked against the current AssemblyAI streaming docs):
 *   wss://streaming.assemblyai.com/v3/ws?token=…&sample_rate=16000&encoding=pcm_s16le&speech_model=…
 *   client -> binary PCM16 chunks of 50–1000 ms, JSON {"type":"Terminate"}
 *   server -> Begin, Turn (transcript, words[{text,start,end,confidence}],
 *             end_of_turn), Termination
 *   Terminate finalises any in-progress turn before Termination arrives.
 */

export type LiveMicError =
  | "mic_blocked"
  | "token_failed"
  | "connection_failed"
  | "unsupported"
  | "stream_error"
  | "no_speech";

export class StreamError extends Error {
  constructor(
    readonly code: LiveMicError,
    detail?: string,
  ) {
    super(detail ?? code);
    this.name = "StreamError";
  }
}

export type MicWord = {
  text: string;
  /** null when the model returned no confidence for this word. */
  confidence: number | null;
  /** Milliseconds from the start of the stream. */
  start: number;
  end: number;
};

export type StreamResult = {
  transcript: string;
  words: MicWord[];
  languageCode: string | null;
  languageConfidence: number | null;
  durationMs: number;
};

export type StreamConnection = {
  token: string;
  websocketUrl: string;
  /** Extra query params from Convex `getStreamConfig` (speech_model, language_detection). */
  connectionParams: Record<string, string>;
};

/** One finalised turn's own data — distinct from the session-wide accumulated result from stop(). */
export type FinalTurn = {
  transcript: string;
  words: MicWord[];
  /** Milliseconds from the start of the stream (from the words' own timings; 0 if the turn had none). */
  startMs: number;
  endMs: number;
};

export type SessionCallbacks = {
  /** Finals so far + the current partial, for the live transcript box. */
  onLive?: (text: string) => void;
  /**
   * A turn was finalised (non-empty text) — receives that turn's own data.
   * A caller that only cares "a turn happened" (LiveMic's single-attempt flow)
   * can ignore the argument; a continuous multi-turn caller (the live room)
   * uses it to save each turn separately as it happens.
   */
  onFinalTurn?: (turn: FinalTurn) => void;
  /** Microphone level 0..1, roughly 10 times a second. */
  onLevel?: (level: number) => void;
  /** The connection failed or dropped while listening. */
  onFatal?: (code: LiveMicError) => void;
  /** Debug hook: message types and lifecycle events. Never receives the token. */
  onEvent?: (type: string, detail?: unknown) => void;
};

type TurnWord = {
  text?: string;
  confidence?: number;
  start?: number;
  end?: number;
};

type ServerMessage = {
  type?: string;
  turn_order?: number;
  end_of_turn?: boolean;
  transcript?: string;
  words?: TurnWord[];
  language_code?: string;
  language_confidence?: number;
  error?: string;
  [key: string]: unknown;
};

const TARGET_RATE = 16_000;
const CHUNK_MS = 100;
const WORKLET_URL = "/worklets/pcm16-processor.js";
const BEGIN_TIMEOUT_MS = 10_000;
const TERMINATION_TIMEOUT_MS = 3_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function mapMicError(error: unknown): StreamError {
  const name = error instanceof DOMException ? error.name : "";
  // Denied, no device, or device busy: for the learner all mean "mic unavailable".
  if (
    name === "NotAllowedError" ||
    name === "SecurityError" ||
    name === "NotFoundError" ||
    name === "NotReadableError" ||
    name === "OverconstrainedError" ||
    name === "AbortError"
  ) {
    return new StreamError("mic_blocked", name);
  }
  return new StreamError("stream_error", error instanceof Error ? error.message : String(error));
}

export class StreamSession {
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private mute: GainNode | null = null;
  private ws: WebSocket | null = null;

  /** False when start() was given an external MediaStream — its tracks are not ours to stop. */
  private ownsMic = true;

  private begun = false;
  private disposed = false;
  private stopping: Promise<StreamResult> | null = null;
  private startedAt = 0;
  private lastLevelAt = 0;

  private readonly finals = new Map<number, ServerMessage>();
  private partial = "";
  private terminated = false;
  private onTerminated: (() => void) | null = null;

  constructor(
    private readonly callbacks: SessionCallbacks = {},
    /** Dev/testing: keep the browser's native rate instead of asking for 16 kHz. */
    private readonly nativeSampleRate = false,
  ) {}

  /** Actual rate of the AudioContext (16000 unless the browser refused). */
  get contextSampleRate(): number | null {
    return this.ctx?.sampleRate ?? null;
  }

  /**
   * Asks for the mic (unless `externalStream` is given — see below), fetches
   * a token, connects, and starts streaming. Must be called from a user
   * gesture (tap) when it acquires its own mic. Resolves once the server has
   * confirmed the session with `Begin` and audio is flowing.
   *
   * @param externalStream When provided, this MediaStream is used instead of
   *   calling getUserMedia — for the live room, where the SAME captured
   *   stream also feeds LiveKit and a local MediaRecorder ("capture the mic
   *   once"). Its tracks are never stopped by this session; the caller owns
   *   its lifecycle.
   */
  async start(
    fetchConnection: () => Promise<StreamConnection>,
    externalStream?: MediaStream,
  ): Promise<void> {
    if (
      typeof window === "undefined" ||
      typeof AudioContext === "undefined" ||
      typeof AudioWorkletNode === "undefined" ||
      (!externalStream && !navigator.mediaDevices?.getUserMedia)
    ) {
      // getUserMedia only exists in secure contexts (https or localhost).
      const secure = typeof window !== "undefined" && window.isSecureContext;
      throw new StreamError("unsupported", secure ? "no Web Audio" : "insecure context");
    }

    // Created synchronously inside the tap so Safari allows audio to run.
    this.ctx = this.createContext();

    if (externalStream) {
      this.mic = externalStream;
      this.ownsMic = false;
    } else {
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        this.ownsMic = true;
      } catch (error) {
        this.releaseAudio();
        throw mapMicError(error);
      }
    }
    if (this.disposed) {
      this.releaseAudio();
      throw new StreamError("stream_error", "cancelled");
    }

    try {
      await this.ctx.resume();
      await this.ctx.audioWorklet.addModule(WORKLET_URL);
    } catch (error) {
      this.releaseAudio();
      throw new StreamError("unsupported", error instanceof Error ? error.message : "worklet");
    }

    // Token AFTER the permission prompt: its redemption window is only 60 s.
    let connection: StreamConnection;
    try {
      connection = await fetchConnection();
    } catch (error) {
      this.releaseAudio();
      throw error instanceof StreamError
        ? error
        : new StreamError("token_failed", error instanceof Error ? error.message : String(error));
    }
    if (this.disposed) {
      this.releaseAudio();
      throw new StreamError("stream_error", "cancelled");
    }

    try {
      await this.openSocket(connection);
    } catch (error) {
      this.dispose();
      throw error;
    }
    if (this.disposed) throw new StreamError("stream_error", "cancelled");

    this.startAudioGraph();
    this.startedAt = performance.now();
    this.callbacks.onEvent?.("streaming", { sampleRate: this.ctx.sampleRate });
  }

  /**
   * Stops listening: releases the mic at once, terminates the session and
   * returns the FINAL transcript with word timings. Safe to call twice.
   */
  stop(): Promise<StreamResult> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  /** Immediate, synchronous teardown (unmount, errors). Never throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "Terminate" }));
      }
    } catch {
      // socket already closing
    }
    this.closeSocket();
    this.releaseAudio();
  }

  // -------------------------------------------------------------------------

  private createContext(): AudioContext {
    if (!this.nativeSampleRate) {
      try {
        return new AudioContext({ sampleRate: TARGET_RATE, latencyHint: "interactive" });
      } catch {
        // Some browsers reject a fixed rate: fall through to their default and
        // let the worklet resample.
      }
    }
    return new AudioContext({ latencyHint: "interactive" });
  }

  private openSocket(connection: StreamConnection): Promise<void> {
    const params = new URLSearchParams({
      sample_rate: String(TARGET_RATE),
      encoding: "pcm_s16le",
      ...connection.connectionParams,
      token: connection.token,
    });
    const ws = new WebSocket(`${connection.websocketUrl}?${params.toString()}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new StreamError("connection_failed", "timed out waiting for Begin")),
        BEGIN_TIMEOUT_MS,
      );
      const fail = (error: StreamError) => {
        clearTimeout(timer);
        reject(error);
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        this.callbacks.onEvent?.(message.type ?? "message", summarise(message));
        switch (message.type) {
          case "Begin":
            this.begun = true;
            clearTimeout(timer);
            resolve();
            return;
          case "Turn":
            this.handleTurn(message);
            return;
          case "Termination":
            this.terminated = true;
            this.onTerminated?.();
            return;
          default:
            if (message.type === "Error" || typeof message.error === "string") {
              const error = new StreamError("stream_error", String(message.error ?? "error"));
              if (!this.begun) fail(error);
              else this.fatal("stream_error");
            }
        }
      };
      ws.onerror = () => {
        if (!this.begun) fail(new StreamError("connection_failed", "socket error"));
      };
      ws.onclose = (event) => {
        this.callbacks.onEvent?.("close", { code: event.code, reason: event.reason });
        if (!this.begun) {
          fail(new StreamError("connection_failed", `closed ${event.code} ${event.reason}`));
        } else if (!this.terminated && !this.stopping && !this.disposed) {
          this.fatal("connection_failed");
        }
        this.onTerminated?.();
      };
    });
  }

  private startAudioGraph(): void {
    const ctx = this.ctx;
    const mic = this.mic;
    if (!ctx || !mic) return;

    this.source = ctx.createMediaStreamSource(mic);
    this.node = new AudioWorkletNode(ctx, "pcm16-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: TARGET_RATE, chunkMs: CHUNK_MS },
    });
    // A silent gain node keeps the graph "pulled" without playing the mic back.
    this.mute = ctx.createGain();
    this.mute.gain.value = 0;

    this.node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      const ws = this.ws;
      if (ws?.readyState === WebSocket.OPEN && this.begun && !this.terminated) {
        ws.send(event.data.pcm);
      }
      const now = performance.now();
      if (now - this.lastLevelAt > 90) {
        this.lastLevelAt = now;
        this.callbacks.onLevel?.(Math.min(1, event.data.level * 4));
      }
    };

    this.source.connect(this.node);
    this.node.connect(this.mute);
    this.mute.connect(ctx.destination);
  }

  private handleTurn(message: ServerMessage): void {
    const order = message.turn_order ?? this.finals.size;
    if (message.end_of_turn) {
      // A model may send an unformatted final and then a formatted one for the
      // same turn: keep the last.
      this.finals.set(order, message);
      this.partial = "";
      const transcript = turnText(message);
      if (transcript !== "") {
        const words = extractWords(message);
        this.callbacks.onFinalTurn?.({
          transcript,
          words,
          startMs: words[0]?.start ?? 0,
          endMs: words.length > 0 ? words[words.length - 1]!.end : 0,
        });
      }
    } else {
      this.partial = turnText(message);
    }
    this.callbacks.onLive?.(this.liveText());
  }

  private orderedFinals(): ServerMessage[] {
    return [...this.finals.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
  }

  private liveText(): string {
    const finals = this.orderedFinals().map(turnText).filter(Boolean);
    return [...finals, this.partial].filter(Boolean).join(" ").trim();
  }

  private fatal(code: LiveMicError): void {
    if (this.disposed) return;
    this.callbacks.onFatal?.(code);
    this.dispose();
  }

  private async doStop(): Promise<StreamResult> {
    const durationMs = this.startedAt > 0 ? performance.now() - this.startedAt : 0;

    // 1. Flush the last few milliseconds from the worklet, then let go of the mic.
    this.node?.port.postMessage("flush");
    await sleep(40);
    this.releaseAudio();

    // 2. Ask the server to finish; it finalises any in-progress turn first.
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN && !this.terminated) {
      const done = new Promise<void>((resolve) => {
        this.onTerminated = resolve;
      });
      ws.send(JSON.stringify({ type: "Terminate" }));
      await Promise.race([done, sleep(TERMINATION_TIMEOUT_MS)]);
    }

    // 3. Close the socket and report.
    this.closeSocket();
    this.disposed = true;
    return this.buildResult(durationMs);
  }

  private buildResult(durationMs: number): StreamResult {
    const turns = this.orderedFinals();
    const transcript = turns.map(turnText).filter(Boolean).join(" ").trim();
    const words: MicWord[] = turns.flatMap(extractWords);
    const withLanguage = [...turns].reverse().find((t) => typeof t.language_code === "string");
    return {
      transcript,
      words,
      languageCode: withLanguage?.language_code ?? null,
      languageConfidence:
        typeof withLanguage?.language_confidence === "number" ? withLanguage.language_confidence : null,
      durationMs: Math.round(durationMs),
    };
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onmessage = null;
    ws.onerror = null;
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
    } catch {
      // already closed
    }
  }

  private releaseAudio(): void {
    try {
      if (this.node) this.node.port.onmessage = null;
      this.source?.disconnect();
      this.node?.disconnect();
      this.mute?.disconnect();
    } catch {
      // nodes already disconnected
    }
    // An externally-provided stream (the live room) outlives this session — its
    // tracks are stopped by whoever captured it, not here.
    if (this.ownsMic) this.mic?.getTracks().forEach((track) => track.stop());
    if (this.ctx && this.ctx.state !== "closed") void this.ctx.close().catch(() => undefined);
    this.source = null;
    this.node = null;
    this.mute = null;
    this.mic = null;
    this.ctx = null;
  }
}

function extractWords(message: ServerMessage): MicWord[] {
  return (message.words ?? []).map((w) => ({
    text: String(w.text ?? ""),
    confidence: typeof w.confidence === "number" ? w.confidence : null,
    start: typeof w.start === "number" ? w.start : 0,
    end: typeof w.end === "number" ? w.end : 0,
  }));
}

function turnText(message: ServerMessage): string {
  const words = message.words;
  if (Array.isArray(words) && words.length > 0) {
    return words
      .map((w) => (typeof w.text === "string" ? w.text : ""))
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return (message.transcript ?? "").trim();
}

function summarise(message: ServerMessage): unknown {
  if (message.type !== "Turn") return message;
  return {
    turn_order: message.turn_order,
    end_of_turn: message.end_of_turn,
    words: message.words?.length ?? 0,
    text: turnText(message),
    language_code: message.language_code,
  };
}
