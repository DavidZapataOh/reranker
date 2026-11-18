import { defineEnv } from "@reranker/env";
import {
  breakerRecord,
  ProviderRejectedError,
  ProviderUnavailableError,
  RateLimitedError,
} from "@reranker/jobs";
import { z } from "@reranker/schema";
import OpenAI, { APIError } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { extractionEnv } from "../env";
import {
  ProviderIncompleteError,
  ProviderRefusalError,
  type StructuredCall,
  type StructuredResult,
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

/**
 * Structured output through the Responses API. The system prompt is the only prompt-cache
 * breakpoint: explicit-only mode never writes the captured answer, which is not reused.
 */
export async function callOpenAI<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
  const format = zodTextFormat(call.schema, call.schemaName);
  const response = await openai()
    .responses.parse(
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
        text: { format },
        reasoning: { effort: call.model.reasoning },
        max_output_tokens: call.maxOutputTokens,
        store: false,
      },
      { signal: call.signal },
    )
    .catch(async (error: unknown) => {
      if (error instanceof APIError) return failure(error);
      // A completed answer whose text fails the schema throws while the SDK parses it.
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        await breakerRecord("openai", "success");
        throw new ProviderIncompleteError("openai", "invalid_output");
      }
      throw error;
    });
  await breakerRecord("openai", "success");

  if (response.status === "incomplete") {
    throw new ProviderIncompleteError("openai", response.incomplete_details?.reason ?? "unknown");
  }
  const content = response.output.flatMap((item) => (item.type === "message" ? item.content : []));
  const refusal = content.find((part) => part.type === "refusal");
  if (refusal) throw new ProviderRefusalError("openai", refusal.refusal);
  if (response.output_parsed === null) {
    throw new ProviderIncompleteError("openai", "invalid_output");
  }

  const usage = response.usage;
  return {
    output: response.output_parsed,
    modelReported: response.model,
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      cachedInputTokens: usage?.input_tokens_details.cached_tokens ?? 0,
      cacheWriteTokens: usage?.input_tokens_details.cache_write_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
    },
    raw: response,
  };
}
