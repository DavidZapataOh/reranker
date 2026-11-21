import { nextResetAt } from "@reranker/jobs";
import {
  ProviderRejectedError,
  ProviderUnavailableError,
  RateLimitedError,
  SpendCapExceededError,
} from "@reranker/jobs/errors";
import { APIConnectionError, APIError, APIUserAbortError } from "openai";

export type MappedOpenAIError = {
  error: Error;
  retryable: boolean;
  breakerFailure: boolean;
  /** Someone has to act on the OpenAI account: a refused key, a retired model, no quota. */
  alert?: "rejected" | "quota";
};

// Nothing told us how long to wait, so a few seconds spreads a burst's retries.
const DEFAULT_WAIT_MS = 5000;

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
const DURATION = /^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/;

/** OpenAI's reset headers are Go durations such as `1.5s`, `6m0s` or `20ms`. */
function durationMs(value: string): number | null {
  if (!DURATION.test(value)) return null;
  let total = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    total += Number(amount) * (UNIT_MS[unit as string] ?? 0);
  }
  return Math.ceil(total);
}

function retryAfterMs(headers: Headers | undefined): number | null {
  if (!headers) return null;
  const ms = headers.get("retry-after-ms")?.trim();
  if (ms && /^\d+(\.\d+)?$/.test(ms)) return Math.ceil(Number(ms));
  const seconds = headers.get("retry-after")?.trim();
  if (seconds && /^\d+(\.\d+)?$/.test(seconds)) return Math.ceil(Number(seconds) * 1000);
  if (seconds) {
    const at = Date.parse(seconds);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  // Either limit can be the one hit, so the later reset is the one that frees the call.
  const resets = ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]
    .map((name) => headers.get(name)?.trim())
    .map((value) => (value ? durationMs(value) : null))
    .filter((value): value is number => value !== null);
  return resets.length ? Math.max(...resets) : null;
}

const unavailable = (headers?: Headers): MappedOpenAIError => ({
  error: new ProviderUnavailableError("openai", retryAfterMs(headers) ?? DEFAULT_WAIT_MS),
  retryable: true,
  breakerFailure: true,
});

// A model or tool the request names that OpenAI refuses means it was retired or renamed.
const PROFILE_PARAM = /^(model|tools)\b/;

function rejected(err: APIError): MappedOpenAIError {
  // Only the code leaves the body: OpenAI's messages can echo the prompt.
  const code = err.code || `http_${err.status}`;
  const account = err.status === 401 || err.status === 403;
  const profile =
    err.status === 404 || err.code === "model_not_found" || PROFILE_PARAM.test(err.param ?? "");
  return {
    error: new ProviderRejectedError("openai", code),
    retryable: false,
    breakerFailure: false,
    ...(account || profile ? { alert: "rejected" as const } : {}),
  };
}

const isTimeout = (err: unknown) =>
  err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");

/** What a failed control call means for the capture step, its breaker and the operators. */
export function mapOpenAIError(err: unknown): MappedOpenAIError {
  if (err instanceof APIUserAbortError) {
    return { error: unavailable().error, retryable: true, breakerFailure: false };
  }
  // A connection that failed or timed out, ours or the SDK's, is an outage like a 5xx.
  if (err instanceof APIConnectionError || isTimeout(err)) return unavailable();
  if (err instanceof APIError) {
    const status = err.status ?? 0;
    if (status === 429) {
      if (err.code === "insufficient_quota") {
        return {
          error: new SpendCapExceededError("openai:insufficient_quota", nextResetAt()),
          retryable: false,
          breakerFailure: false,
          alert: "quota",
        };
      }
      return {
        error: new RateLimitedError(retryAfterMs(err.headers) ?? DEFAULT_WAIT_MS, "OpenAI"),
        retryable: true,
        breakerFailure: false,
      };
    }
    if (status >= 500) return unavailable(err.headers);
    // Request timeout and conflict are transient on OpenAI's side, not a fault of the request.
    if (status === 408 || status === 409)
      return { ...unavailable(err.headers), breakerFailure: false };
    return rejected(err);
  }
  const error = err instanceof Error ? err : new Error(String(err));
  const retryable = error instanceof RateLimitedError || error instanceof ProviderUnavailableError;
  return { error, retryable, breakerFailure: false };
}
