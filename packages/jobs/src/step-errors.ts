import { CaptureChannelDisabledError, FlagsNotReadyError } from "@reranker/flags";
import { isAppError } from "@reranker/schema";
import { FatalError, RetryableError } from "workflow";
import {
  InvalidInputError,
  NotFoundError,
  ProviderRejectedError,
  ProviderUnavailableError,
  QuotaExceededError,
  RateLimitedError,
  SpendCapExceededError,
} from "./errors";

// The panel shows only the message, so the type travels in it.
const label = (err: Error) => `${err.name}: ${err.message}`;

const retryIn = (err: Error, ms: number) => new RetryableError(label(err), { retryAfter: ms });
const fatal = (err: Error) => new FatalError(label(err));

/**
 * Maps a failure to what the step runtime understands: a retry after the exact wait the cause
 * gave, or no retry at all. Anything unknown is returned as is so the default retries apply.
 */
export function toStepError(err: unknown): Error {
  if (err instanceof RateLimitedError || err instanceof ProviderUnavailableError) {
    return retryIn(err, err.retryAfterMs);
  }
  if (err instanceof QuotaExceededError) {
    return new RetryableError(label(err), { retryAfter: err.resetsAt });
  }
  if (err instanceof FlagsNotReadyError) return retryIn(err, err.retryAfterMs);
  if (isAppError(err)) {
    if (!err.retryable) return fatal(err);
    return err.retryAfterSeconds === undefined ? err : retryIn(err, err.retryAfterSeconds * 1000);
  }
  if (
    err instanceof SpendCapExceededError ||
    err instanceof ProviderRejectedError ||
    err instanceof InvalidInputError ||
    err instanceof NotFoundError ||
    err instanceof CaptureChannelDisabledError
  ) {
    return fatal(err);
  }
  return err instanceof Error ? err : new Error(String(err));
}
