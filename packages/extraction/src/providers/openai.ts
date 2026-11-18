import { defineEnv } from "@reranker/env";
import {
  breakerRecord,
  ProviderRejectedError,
  ProviderUnavailableError,
  RateLimitedError,
} from "@reranker/jobs";
import type { z } from "@reranker/schema";
import OpenAI, { APIError } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { Response } from "openai/resources/responses/responses";
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

// 429s that only a billing change fixes; waiting cannot make the call succeed
// (https://developers.openai.com/api/docs/guides/error-codes).
const BILLING_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

const openAiKeyEnv = extractionEnv.pick({ OPENAI_API_KEY: true });
let client: OpenAI | undefined;

// Retries belong to the caller, which holds the provider slot and the spend reservation.
const openai = (): OpenAI =>
  (client ??= new OpenAI({ apiKey: defineEnv([openAiKeyEnv]).OPENAI_API_KEY, maxRetries: 0 }));

function retryAfterMs(headers: Headers | undefined): number {
  const ms = Number.parseFloat(headers?.get("retry-after-ms") ?? "");
  if (ms > 0) return ms;
  const seconds = Number.parseFloat(headers?.get("retry-after") ?? "");
  return seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
}

// Only OpenAI's code leaves the error: its message can echo the captured answer.
async function failure(error: unknown): Promise<never> {
  if (!(error instanceof APIError)) throw error;
  const outage = error.status === undefined || error.status >= 500;
  await breakerRecord("openai", outage ? "failure" : "success");
  if (outage) throw new ProviderUnavailableError("openai", retryAfterMs(error.headers));
  const code = typeof error.code === "string" ? error.code : undefined;
  const type = typeof error.type === "string" ? error.type : undefined;
  if (error.status === 429 && !BILLING_CODES.has(code ?? type ?? "")) {
    throw new RateLimitedError(retryAfterMs(error.headers), "OpenAI");
  }
  throw new ProviderRejectedError("openai", code ?? `http_${error.status}`);
}

function usageOf(response: Response): StructuredUsage | undefined {
  const usage = response.usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens,
    cacheWriteTokens: usage.input_tokens_details.cache_write_tokens,
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
 * Structured output through the Responses API. The system prompt is the only prompt-cache
 * breakpoint: explicit-only mode never writes the captured answer, which is not reused.
 * Every answer that comes back was billed, so every error built from one carries its usage.
 */
export async function callOpenAI<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
  // Parsed here rather than by `responses.parse`, whose schema errors drop the billed usage.
  const response = await openai()
    .responses.create(
      {
        model: call.model.model,
        input: [
          {
            role: "developer",
            content: [
              {
                type: "input_text",
                text: call.system,
                prompt_cache_breakpoint: { mode: "explicit" },
              },
            ],
          },
          { role: "user", content: call.user },
        ],
        prompt_cache_options: { mode: "explicit" },
        text: { format: zodTextFormat(call.schema, call.schemaName) },
        reasoning: { effort: call.model.reasoning },
        max_output_tokens: call.maxOutputTokens,
        store: false,
      },
      { signal: call.signal },
    )
    .catch(failure);
  await breakerRecord("openai", "success");

  const usage = usageOf(response);
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason ?? "unknown";
    throw new ProviderIncompleteError("openai", reason, usage);
  }
  const content = response.output.flatMap((item) => (item.type === "message" ? item.content : []));
  const refusal = content.find((part) => part.type === "refusal");
  if (refusal) throw new ProviderRefusalError("openai", refusal.refusal, usage);
  const text = content.find((part) => part.type === "output_text")?.text;
  const output = text === undefined ? undefined : parsed(call.schema, text);
  if (output === undefined || !usage) {
    // Without usage the caller settles the reservation, so a valid output cannot be kept either.
    throw new ProviderIncompleteError(
      "openai",
      output === undefined ? "invalid_output" : "missing_usage",
      usage,
    );
  }

  return { output, modelReported: response.model, usage, raw: response };
}
