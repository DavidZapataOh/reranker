import type { JobPriority, PaidProvider } from "./providers";

// The names are the error types of the platform's error catalog, so a step failure reads the same
// in logs, alerts and any runtime that replaces this one.

/** A provider or internal limit asked us to wait; the same call succeeds after the delay. */
export class RateLimitedError extends Error {
  override readonly name = "RateLimited";
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Rate limited, retry in ${retryAfterMs} ms`);
    this.retryAfterMs = retryAfterMs;
  }
}

/** The provider is failing or its breaker is open; retry after the delay it advertises. */
export class ProviderUnavailableError extends Error {
  override readonly name = "ProviderUnavailable";
  readonly provider: PaidProvider;
  readonly retryAfterMs: number;

  constructor(provider: PaidProvider, retryAfterMs: number) {
    super(`${provider} is unavailable, retry in ${retryAfterMs} ms`);
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The provider refused the request itself; sending it again cannot change the answer. */
export class ProviderRejectedError extends Error {
  override readonly name = "ProviderRejected";
  readonly provider: PaidProvider;
  readonly providerCode: string;

  constructor(provider: PaidProvider, providerCode: string) {
    super(`${provider} rejected the request (${providerCode})`);
    this.provider = provider;
    this.providerCode = providerCode;
  }
}

/** A daily spend cap has no room left; capacity returns at `resetsAt`. */
export class SpendCapExceededError extends Error {
  override readonly name = "SpendCapExceeded";
  readonly scope: string;
  readonly resetsAt: Date;

  constructor(scope: string, resetsAt: Date) {
    super(`Spend cap reached for ${scope}`);
    this.scope = scope;
    this.resetsAt = resetsAt;
  }
}

/** A daily quota class is used up; a step may wait for `resetsAt` and try again. */
export class QuotaExceededError extends Error {
  override readonly name = "QuotaExceeded";
  readonly quota: string;
  readonly priority: JobPriority;
  readonly resetsAt: Date;

  constructor(quota: string, priority: JobPriority, resetsAt: Date) {
    super(`Quota ${quota} exhausted for ${priority} priority`);
    this.quota = quota;
    this.priority = priority;
    this.resetsAt = resetsAt;
  }
}

export class InvalidInputError extends Error {
  override readonly name = "InvalidInput";
}

export class NotFoundError extends Error {
  override readonly name = "NotFound";
}

/** Error names a step must never retry. */
export const NON_RETRYABLE = [
  "ProviderRejected",
  "InvalidInput",
  "SpendCapExceeded",
  "NotFound",
  "CaptureChannelDisabled",
] as const;
