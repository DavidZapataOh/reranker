import Anthropic, { APIError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { defineEnv } from "@reranker/env";
import {
  breakerRecord,
  ProviderRejectedError,
  ProviderUnavailableError,
  RateLimitedError,
} from "@reranker/jobs";
import type { z } from "@reranker/schema";
import { extractionEnv } from "../env";
import {
  ProviderIncompleteError,
  ProviderRefusalError,
  type StructuredCall,
  type StructuredResult,
  type StructuredUsage,
} from "./types";

// Without Retry-After a one-second wait spreads the retries of a burst.
const DEFAULT_RETRY_AFTER_MS = 1000;

// The monthly spend cap answers 429 until access resumes; waiting cannot fix it
// (https://platform.claude.com/docs/en/api/rate-limits#reaching-your-spend-cap).
const SPEND_CAP_CODE = "enforced_spend_limit_reached";

const anthropicKeyEnv = extractionEnv.pick({ ANTHROPIC_API_KEY: true });
let client: Anthropic | undefined;

// Retries belong to the caller, which holds the provider slot and the spend reservation.
const anthropic = (): Anthropic =>
  (client ??= new Anthropic({
    apiKey: defineEnv([anthropicKeyEnv]).ANTHROPIC_API_KEY,
    maxRetries: 0,
  }));

function retryAfterMs(headers: Headers | undefined): number {
  const seconds = Number.parseFloat(headers?.get("retry-after") ?? "");
  return seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
}

// Only Anthropic's type and code leave the error: its message can echo the captured answer.
async function failure(error: unknown): Promise<never> {
  if (!(error instanceof APIError)) throw error;
  const outage = error.status === undefined || error.status >= 500;
  await breakerRecord("anthropic", outage ? "failure" : "success");
  if (outage) throw new ProviderUnavailableError("anthropic", retryAfterMs(error.headers));
  if (error.status === 429 && error.errorCode !== SPEND_CAP_CODE) {
    throw new RateLimitedError(retryAfterMs(error.headers), "Anthropic");
  }
  throw new ProviderRejectedError(
    "anthropic",
    error.errorCode ?? error.type ?? `http_${error.status}`,
  );
}

// `input_tokens` excludes the cache reads and writes, which are billed at their own rates.
function usageOf(message: Message): StructuredUsage | undefined {
  const usage = message.usage;
  if (!usage) return undefined;
  const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens + cachedInputTokens + cacheWriteTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens: usage.output_tokens,
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
 * Structured output through the Messages API. Only the system prompt carries a cache breakpoint,
 * so the captured answer, which is never reused, is never written to the cache. Effort `low` is
 * the least thinking every Claude model accepts. Every answer that comes back was billed, so every
 * error built from one carries its usage.
 */
export async function callAnthropic<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
  // Parsed here rather than by `messages.parse`, whose schema errors drop the billed usage.
  const message = await anthropic()
    .messages.create(
      {
        model: call.model.model,
        max_tokens: call.maxOutputTokens,
        system: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: call.user }],
        output_config: { format: zodOutputFormat(call.schema), effort: "low" },
      },
      { signal: call.signal },
    )
    .catch(failure);
  await breakerRecord("anthropic", "success");

  const usage = usageOf(message);
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category ?? "refusal";
    throw new ProviderRefusalError("anthropic", category, usage);
  }
  if (message.stop_reason !== "end_turn") {
    throw new ProviderIncompleteError("anthropic", message.stop_reason ?? "unknown", usage);
  }
  const text = message.content.find((block) => block.type === "text")?.text;
  const output = text === undefined ? undefined : parsed(call.schema, text);
  if (output === undefined || !usage) {
    // Without usage the caller settles the reservation, so a valid output cannot be kept either.
    throw new ProviderIncompleteError(
      "anthropic",
      output === undefined ? "invalid_output" : "missing_usage",
      usage,
    );
  }

  return { output, modelReported: message.model, usage, raw: message };
}
