import { GoogleGenAI, type GoogleGenAIInteraction } from "@google/genai";
import { defineEnv } from "@reranker/env";
import {
  breakerRecord,
  ProviderRejectedError,
  ProviderUnavailableError,
  RateLimitedError,
} from "@reranker/jobs";
import { z } from "@reranker/schema";
import { extractionEnv } from "../env";
import {
  type ModelRef,
  ProviderIncompleteError,
  ProviderRefusalError,
  type StructuredCall,
  type StructuredResult,
  type StructuredUsage,
} from "./types";

// Without a retry header a one-second wait spreads the retries of a burst.
const DEFAULT_RETRY_AFTER_MS = 1000;

// Codes that waiting cannot fix: empty Prepay balance and the daily quota
// (https://ai.google.dev/gemini-api/docs/api-errors).
const BILLING_CODES = new Set(["payment_required", "quota_exceeded"]);

// Generation blocked by policy: the model declined, and the call was billed.
const BLOCKED_CODES = new Set([
  "safety",
  "recitation",
  "language",
  "prohibited_content",
  "spii",
  "blocklist",
  "content_blocked",
]);

// Models whose lowest thinking level is `low` (https://ai.google.dev/gemini-api/docs/thinking).
const NO_MINIMAL_THINKING = new Set(["gemini-3.8-flash"]);

const geminiKeyEnv = extractionEnv.pick({ GEMINI_API_KEY: true });
let client: GoogleGenAI | undefined;

const gemini = (): GoogleGenAI =>
  (client ??= new GoogleGenAI({ apiKey: defineEnv([geminiKeyEnv]).GEMINI_API_KEY }));

// Gemini 3 cannot turn thinking off, so `none` asks for the least thinking the model allows.
function thinkingLevel(model: ModelRef): "minimal" | "low" {
  return model.reasoning === "low" || NO_MINIMAL_THINKING.has(model.model) ? "low" : "minimal";
}

/** The Interactions client's errors are not exported, so they are read by shape. */
interface InteractionsApiError {
  status: number | undefined;
  headers: Headers | undefined;
  error: unknown;
}

function isApiError(error: unknown): error is InteractionsApiError {
  return error instanceof Error && "status" in error && "headers" in error && "error" in error;
}

function retryAfterMs(headers: Headers | undefined): number {
  const ms = Number.parseFloat(headers?.get("retry-after-ms") ?? "");
  if (ms > 0) return ms;
  const seconds = Number.parseFloat(headers?.get("retry-after") ?? "");
  return seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
}

function codeOf(body: unknown): string | undefined {
  const inner = body && typeof body === "object" && "error" in body ? body.error : body;
  const code = inner && typeof inner === "object" && "code" in inner ? inner.code : undefined;
  return typeof code === "string" ? code : undefined;
}

// Only Gemini's code leaves the error: its message can echo the captured answer.
async function failure(error: unknown): Promise<never> {
  if (!isApiError(error)) throw error;
  const outage = error.status === undefined || error.status >= 500;
  await breakerRecord("gemini", outage ? "failure" : "success");
  if (outage) throw new ProviderUnavailableError("gemini", retryAfterMs(error.headers));
  const code = codeOf(error.error);
  if (error.status === 429 && !BILLING_CODES.has(code ?? "")) {
    throw new RateLimitedError(retryAfterMs(error.headers), "Gemini");
  }
  throw new ProviderRejectedError("gemini", code ?? `http_${error.status}`);
}

// Thinking is billed as output (https://ai.google.dev/gemini-api/docs/thinking#pricing);
// implicit caching bills no write.
function usageOf(interaction: GoogleGenAIInteraction): StructuredUsage | undefined {
  const usage = interaction.usage;
  if (usage?.total_input_tokens === undefined || usage.total_output_tokens === undefined) {
    return undefined;
  }
  return {
    inputTokens: usage.total_input_tokens,
    cachedInputTokens: usage.total_cached_tokens ?? 0,
    cacheWriteTokens: 0,
    outputTokens: usage.total_output_tokens + (usage.total_thought_tokens ?? 0),
  };
}

function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Structured output through the Interactions API, stateless (`store: false`) so Google keeps no
 * copy of the captured answer. The system instruction leads the prompt, so implicit caching can
 * only reuse it. Every answer that comes back was billed, so every error built from one carries
 * its usage.
 */
export async function callGemini<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
  const interaction = await gemini()
    .interactions.create(
      {
        model: call.model.model,
        system_instruction: call.system,
        input: call.user,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: z.toJSONSchema(call.schema),
        },
        generation_config: {
          thinking_level: thinkingLevel(call.model),
          max_output_tokens: call.maxOutputTokens,
        },
        store: false,
        // One request per call: the reservation and the deadline cover a single decode.
        automatic_continuation: false,
      },
      // Retries belong to the caller, which holds the provider slot and the spend reservation.
      { signal: call.signal, maxRetries: 0 },
    )
    .catch(failure);
  await breakerRecord("gemini", "success");

  const usage = usageOf(interaction);
  if (interaction.status === "failed") {
    const code = interaction.errors?.[0]?.code ?? "failed";
    if (BLOCKED_CODES.has(code)) throw new ProviderRefusalError("gemini", code, usage);
    throw new ProviderIncompleteError("gemini", code, usage);
  }
  if (interaction.status !== "completed") {
    throw new ProviderIncompleteError("gemini", interaction.status, usage);
  }
  const text = interaction.output_text;
  const output = text === undefined ? undefined : parsed(call.schema, text);
  if (output === undefined || !usage) {
    // Without usage the caller settles the reservation, so a valid output cannot be kept either.
    throw new ProviderIncompleteError(
      "gemini",
      output === undefined ? "invalid_output" : "missing_usage",
      usage,
    );
  }

  return { output, modelReported: interaction.model ?? call.model.model, usage, raw: interaction };
}
