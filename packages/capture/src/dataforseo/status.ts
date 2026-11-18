import {
  ProviderRejectedError,
  ProviderUnavailableError,
  RateLimitedError,
} from "@reranker/jobs/errors";
import { z } from "@reranker/schema";

export type DataForSeoOutcome =
  | { ok: true }
  | { ok: false; error: Error; retryable: boolean; breakerFailure: boolean; alert?: "balance" };

type Failure = Extract<DataForSeoOutcome, { ok: false }>;

// Codes from https://docs.dataforseo.com/v3/appendix/errors/. 20100 is task_post's "task created".
const SUCCESS = new Set([20000, 20100]);

// Per-minute and simultaneous-request limits; a few seconds is enough for either to clear.
const RATE_LIMITED = new Set([40202, 40209]);
const RETRY_AFTER_MS = 5000;

// Waiting cannot fix these: the account has to be funded or fixed in the DataForSEO dashboard.
const BALANCE: ReadonlyMap<number, string> = new Map([
  [40200, "payment_required"],
  [40203, "cost_limit_exceeded"],
  [40210, "insufficient_funds"],
]);
const ACCOUNT: ReadonlyMap<number, string> = new Map([
  [40100, "unauthorized"],
  [40104, "account_not_verified"],
  [40201, "account_paused"],
  [40207, "ip_not_whitelisted"],
]);

// The task failed upstream but was not billed and DataForSEO itself is up, so it is not an outage.
const TRANSIENT_TASK = new Set([40101, 40103, 40107]);

const Envelope = z.object({
  status_code: z.int(),
  tasks: z
    .array(z.object({ status_code: z.int() }))
    .nullish()
    .catch(null),
});

/** The code that decides the call: the envelope's when it failed, otherwise the task's. */
export function providerStatusCode(body: unknown): number | null {
  const envelope = Envelope.safeParse(body);
  if (!envelope.success) return null;
  const { status_code, tasks } = envelope.data;
  if (!SUCCESS.has(status_code)) return status_code;
  return tasks?.[0]?.status_code ?? null;
}

const unavailable = (breakerFailure: boolean): Failure => ({
  ok: false,
  error: new ProviderUnavailableError("dataforseo", RETRY_AFTER_MS),
  retryable: true,
  breakerFailure,
});

const rejected = (providerCode: string): Failure => ({
  ok: false,
  error: new ProviderRejectedError("dataforseo", providerCode),
  retryable: false,
  breakerFailure: false,
});

const rateLimited = (): Failure => ({
  ok: false,
  error: new RateLimitedError(RETRY_AFTER_MS, "DataForSEO"),
  retryable: true,
  breakerFailure: false,
});

function fromCode(code: number): DataForSeoOutcome {
  if (SUCCESS.has(code)) return { ok: true };
  if (RATE_LIMITED.has(code)) return rateLimited();
  const balance = BALANCE.get(code);
  if (balance) return { ...rejected(balance), alert: "balance" };
  const account = ACCOUNT.get(code);
  if (account) return rejected(account);
  if (TRANSIENT_TASK.has(code)) return unavailable(false);
  if (code >= 50000) return unavailable(true);
  return rejected(String(code));
}

/**
 * DataForSEO answers most errors with HTTP 200 and the code in the body, so the body's code wins
 * over the HTTP status. Only codes leave the body: its messages can echo the prompt.
 */
export function mapDataForSeoStatus(input: {
  httpStatus: number | null;
  body: unknown | null;
  timedOut: boolean;
}): DataForSeoOutcome {
  if (input.timedOut) return unavailable(true);
  const code = providerStatusCode(input.body);
  if (code !== null) return fromCode(code);
  const { httpStatus } = input;
  if (httpStatus === 429) return rateLimited();
  // A 200 without a readable status is a broken answer, as much an outage as a 5xx.
  if (httpStatus === null || httpStatus === 200 || httpStatus >= 500) return unavailable(true);
  return rejected(`http_${httpStatus}`);
}
