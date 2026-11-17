import { CaptureChannelDisabledError, FlagsNotReadyError } from "@reranker/flags";
import { isAppError } from "@reranker/schema";
import {
  InvalidInputError,
  JobAttemptsExhaustedError,
  NotFoundError,
  ProviderRejectedError,
  ProviderUnavailableError,
  QuotaExceededError,
  RateLimitedError,
  SpendCapExceededError,
} from "./errors";

/**
 * What a step failure calls for: no retry, a retry after the wait its cause gave, or the runtime's
 * default retries (`after` undefined).
 */
export type StepOutcome = { fatal: true } | { fatal: false; after?: number | Date };

// Kept apart from step-errors so telemetry can classify a failure without loading the runtime.
export function stepOutcome(err: unknown): StepOutcome {
  if (err instanceof RateLimitedError || err instanceof ProviderUnavailableError) {
    return { fatal: false, after: err.retryAfterMs };
  }
  if (err instanceof QuotaExceededError) return { fatal: false, after: err.resetsAt };
  if (err instanceof FlagsNotReadyError) return { fatal: false, after: err.retryAfterMs };
  if (isAppError(err)) {
    if (!err.retryable) return { fatal: true };
    return err.retryAfterSeconds === undefined
      ? { fatal: false }
      : { fatal: false, after: err.retryAfterSeconds * 1000 };
  }
  if (
    err instanceof SpendCapExceededError ||
    err instanceof ProviderRejectedError ||
    err instanceof InvalidInputError ||
    err instanceof NotFoundError ||
    err instanceof JobAttemptsExhaustedError ||
    err instanceof CaptureChannelDisabledError
  ) {
    return { fatal: true };
  }
  return { fatal: false };
}
