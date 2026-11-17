import { FatalError, RetryableError } from "workflow";
import { stepOutcome } from "./step-outcome";

// The panel shows only the message, so the type travels in it.
const label = (err: Error) => `${err.name}: ${err.message}`;

/**
 * Maps a failure to what the step runtime understands: a retry after the exact wait the cause
 * gave, or no retry at all. Anything unknown is returned as is so the default retries apply.
 */
export function toStepError(err: unknown): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  const outcome = stepOutcome(err);
  if (outcome.fatal) return new FatalError(label(error));
  if (outcome.after === undefined) return error;
  return new RetryableError(label(error), { retryAfter: outcome.after });
}
