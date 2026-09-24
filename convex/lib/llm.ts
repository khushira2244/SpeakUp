/**
 * Thin, swappable wrapper around the AssemblyAI LLM Gateway.
 *
 * Contract enforced here for every LLM call in the app:
 *   - Credentials and model come from env vars. The model is NEVER hardcoded
 *     (LLM_MODEL), and the endpoint itself is swappable (LLM_BASE_URL), so the
 *     provider can change without a code change.
 *   - Structured output via `response_format: { type: "json_schema", ... }`
 *     with `strict: true`, plus the gateway's `json-repair` post-processing
 *     step as a second line of defence against malformed JSON.
 *   - A wall-clock timeout via AbortController.
 *   - Exactly one retry on a transport failure, a non-2xx response, malformed
 *     JSON, or output that fails the caller's validator.
 *   - A typed parse: the caller supplies a validator, and only its return value
 *     ever escapes this module. The JSON schema constrains the shape; the
 *     validator is still authoritative and still runs before any database write.
 *
 * SECURITY: ASSEMBLYAI_API_KEY is read from the deployment env and used only
 * inside Convex actions. It never reaches a client.
 *
 * Runs in the default Convex V8 runtime (`fetch` is built in), so no
 * `"use node";` and no provider SDK dependency.
 */

import { ValidationError } from "./validate";

export class LlmError extends Error {
  readonly attempts: number;
  constructor(message: string, attempts: number) {
    super(message);
    this.name = "LlmError";
    this.attempts = attempts;
  }
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

/** AssemblyAI LLM Gateway chat-completions endpoint. */
export const DEFAULT_LLM_BASE_URL =
  "https://llm-gateway.assemblyai.com/v1/chat/completions";
export const DEFAULT_LLM_MODEL = "gemini-2.5-flash-lite";

const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * The gateway defaults `max_tokens` to 1000, which silently truncates the
 * larger generations (a 40-word goal vocabulary with native-language meanings
 * runs well past that). Always send an explicit budget.
 */
const DEFAULT_MAX_TOKENS = 8_000;
/** Exactly one retry, per the app's hard rules. */
const TOTAL_ATTEMPTS = 2;

/** A JSON Schema object describing the expected response shape. */
export type JsonSchema = Record<string, unknown>;

/**
 * One HTTP request actually sent to the gateway (each retry counts
 * separately). Recorded once the attempt's outcome is known, so `ok` means
 * "received AND passed validation", and a rejection carries its reason.
 */
export type LlmCallRecord = {
  model: string;
  schemaName: string;
  attempt: number;
  ok: boolean;
  errorName?: string | undefined;
  errorMessage?: string | undefined;
};

export type LlmConfig = { apiKey: string; model: string; baseUrl: string };

/**
 * Reads LLM configuration from the deployment environment.
 * Throws a distinguishable error when the deployment is not configured, so
 * callers can surface "missing dependency" rather than a generic failure.
 */
export function readLlmConfig(): LlmConfig {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new LlmConfigError(
      "ASSEMBLYAI_API_KEY is not set on this Convex deployment. Set it with: npx convex env set ASSEMBLYAI_API_KEY <key>",
    );
  }
  const model = process.env.LLM_MODEL?.trim();
  const baseUrl = process.env.LLM_BASE_URL?.trim();
  return {
    apiKey: apiKey.trim(),
    model: model && model.length > 0 ? model : DEFAULT_LLM_MODEL,
    baseUrl: baseUrl && baseUrl.length > 0 ? baseUrl : DEFAULT_LLM_BASE_URL,
  };
}

/** True when the deployment has everything needed to call the LLM. */
export function isLlmConfigured(): boolean {
  try {
    readLlmConfig();
    return true;
  } catch {
    return false;
  }
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  llm_status_code?: number;
  metadata?: { errors?: unknown };
};

async function rawCompletion(
  config: LlmConfig,
  args: {
    system: string;
    user: string;
    schemaName: string;
    schema: JsonSchema;
    timeoutMs: number;
    maxTokens: number;
  },
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const response = await fetch(config.baseUrl, {
      method: "POST",
      headers: {
        // The gateway takes the raw API key, with no "Bearer " prefix.
        authorization: config.apiKey,
        "content-type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        max_tokens: args.maxTokens,
        // Structured output: the model is constrained to this schema.
        response_format: {
          type: "json_schema",
          json_schema: {
            name: args.schemaName,
            schema: args.schema,
            strict: true,
          },
        },
        // Gateway-side repair of trailing commas, stray fences, missing braces.
        post_processing_steps: [{ type: "json-repair" }],
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.user },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "<unreadable body>");
      throw new Error(
        `LLM Gateway returned ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
      );
    }

    const payload = (await response.json()) as ChatCompletionResponse;

    // The gateway can return HTTP 200 while the upstream model call failed.
    if (
      typeof payload.llm_status_code === "number" &&
      (payload.llm_status_code < 200 || payload.llm_status_code >= 300)
    ) {
      throw new Error(
        `LLM Gateway reported upstream status ${payload.llm_status_code}: ${JSON.stringify(
          payload.metadata ?? {},
        ).slice(0, 300)}`,
      );
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("LLM Gateway returned an empty completion");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls the LLM, parses its structured JSON output, and validates it.
 *
 * Retries exactly once. On the retry, the previous failure is fed back to the
 * model so it can correct its own output shape.
 *
 * @throws {LlmConfigError} when env vars are missing (not retried).
 * @throws {LlmError} when both attempts fail. The message names the last cause.
 */
export async function llmJson<T>(args: {
  system: string;
  user: string;
  /** Identifies the schema to the gateway; snake_case, no spaces. */
  schemaName: string;
  /** JSON Schema the response is constrained to. */
  schema: JsonSchema;
  /** Validates the parsed JSON. Must throw (ideally `ValidationError`) on bad shape. */
  validate: (raw: unknown) => T;
  timeoutMs?: number;
  maxTokens?: number;
  /** Called once per HTTP request actually sent. Used for usage metering. */
  recordCall?: (entry: LlmCallRecord) => Promise<void>;
}): Promise<T> {
  const config = readLlmConfig();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = args.maxTokens ?? DEFAULT_MAX_TOKENS;

  let lastError = "unknown error";

  for (let attempt = 1; attempt <= TOTAL_ATTEMPTS; attempt++) {
    const user =
      attempt === 1
        ? args.user
        : `${args.user}\n\nYour previous response was rejected for this reason:\n${lastError}\n\nReturn corrected JSON that satisfies every requirement above.`;

    // Exactly one metering record per gateway request, written once this
    // attempt's outcome (transport + validation) is known.
    const record = async (outcome: { ok: true } | { ok: false; error: unknown }) => {
      await args.recordCall?.({
        model: config.model,
        schemaName: args.schemaName,
        attempt,
        ok: outcome.ok,
        ...(outcome.ok
          ? {}
          : {
              errorName: outcome.error instanceof Error ? outcome.error.name : "Error",
              errorMessage: (outcome.error instanceof Error
                ? outcome.error.message
                : String(outcome.error)
              ).slice(0, 500),
            }),
      });
    };

    // --- The gateway request itself -------------------------------------
    let content: string;
    try {
      content = await rawCompletion(config, {
        system: args.system,
        user,
        schemaName: args.schemaName,
        schema: args.schema,
        timeoutMs,
        maxTokens,
      });
    } catch (error) {
      lastError =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      await record({ ok: false, error });
      if (attempt === TOTAL_ATTEMPTS) {
        throw new LlmError(
          `LLM call failed after ${TOTAL_ATTEMPTS} attempts. Last error: ${lastError}`,
          TOTAL_ATTEMPTS,
        );
      }
      continue;
    }

    // --- Parse + authoritative validation (no further gateway traffic) ----
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new ValidationError(
          `response was not valid JSON (first 300 chars: ${content.slice(0, 300)})`,
        );
      }
      // The schema constrains shape; this enforces the app's actual rules
      // (counts, distinctness, allowed vocabulary, ...).
      const validated = args.validate(parsed);
      await record({ ok: true });
      return validated;
    } catch (error) {
      lastError =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      await record({ ok: false, error });
      if (attempt === TOTAL_ATTEMPTS) {
        throw new LlmError(
          `LLM call failed after ${TOTAL_ATTEMPTS} attempts. Last error: ${lastError}`,
          TOTAL_ATTEMPTS,
        );
      }
    }
  }

  // Unreachable; the loop either returns or throws.
  throw new LlmError(`LLM call failed: ${lastError}`, TOTAL_ATTEMPTS);
}
