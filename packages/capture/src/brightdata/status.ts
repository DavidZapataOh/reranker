import {
  ProviderRejectedError,
  ProviderUnavailableError,
  RateLimitedError,
} from "@reranker/jobs/errors";

export type Classified =
  | { kind: "ok"; record: Record<string, unknown> }
  // The call worked but brought no answer: sealed as it came, at no cost.
  | { kind: "provider_error"; errorCode: string | null }
  | {
      kind: "error";
      error: RateLimitedError | ProviderRejectedError | ProviderUnavailableError;
      breaker: "failure" | "none";
      /** The account itself is refused; someone has to act in the Bright Data panel. */
      alert?: "rejected";
    };

type Failure = Extract<Classified, { kind: "error" }>;

// Nothing told us how long to wait, so a few seconds spreads a burst's retries.
const UNAVAILABLE_MS = 5000;

// Bright Data's 429 guidance: 2, 4, 8, 16 and 32 s with random jitter.
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 32_000;
const JITTER_MS = 1000;

const ACCOUNT: ReadonlyMap<number, string> = new Map([
  [401, "unauthorized"],
  [402, "insufficient_balance"],
  [403, "forbidden"],
]);

// A failed snapshot carries only free text; these are the messages its reference lists that are
// not outages. Anything else, documented or new, is treated as one.
const FAILED_SNAPSHOT: ReadonlyArray<[RegExp, () => Classified]> = [
  [/^account is suspended/i, () => rejected("account_suspended", "rejected")],
  [/^account is new/i, () => rejected("account_inactive", "rejected")],
  [/^input validation failed/i, () => rejected("validation_error")],
  [
    /^(snapshot is empty|no data found)/i,
    () => ({ kind: "provider_error", errorCode: "snapshot_empty" }),
  ],
];

function rejected(code: string, alert?: "rejected"): Failure {
  return {
    kind: "error",
    error: new ProviderRejectedError("brightdata", code),
    breaker: "none",
    ...(alert ? { alert } : {}),
  };
}

const unavailable = (retryAfterMs: number, breaker: Failure["breaker"]): Failure => ({
  kind: "error",
  error: new ProviderUnavailableError("brightdata", retryAfterMs),
  breaker,
});

function retryAfterHeader(headers: Headers): number | null {
  const value = headers.get("retry-after")?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function backoffMs(attempt: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (Math.max(1, attempt) - 1), BACKOFF_MAX_MS);
  return base + Math.floor(Math.random() * JITTER_MS);
}

function json(body: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return { ok: false };
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

function fromRecords(records: unknown[]): Classified {
  if (!records.every(isObject)) return { kind: "provider_error", errorCode: "unexpected_body" };
  // With include_errors=true a failed input arrives as a record with `error`/`error_code`.
  const answer = records.find((r) => r.error === undefined && r.error_code === undefined);
  if (answer) return { kind: "ok", record: answer };
  return { kind: "provider_error", errorCode: text(records[0]?.error_code) };
}

function fromProgress(progress: Record<string, unknown>): Classified {
  if (progress.status === "canceled") return unavailable(UNAVAILABLE_MS, "none");
  const message = text(progress.error_message) ?? "";
  const known = FAILED_SNAPSHOT.find(([pattern]) => pattern.test(message));
  return known ? known[1]() : unavailable(UNAVAILABLE_MS, "failure");
}

function fromOk(body: Uint8Array): Classified {
  const parsed = json(body);
  if (!parsed.ok) return { kind: "provider_error", errorCode: "invalid_json" };
  const { value } = parsed;
  if (Array.isArray(value)) return fromRecords(value);
  // scrapeOne hands back a progress body when the snapshot ended without records.
  if (isObject(value) && (value.status === "failed" || value.status === "canceled")) {
    return fromProgress(value);
  }
  return { kind: "provider_error", errorCode: "unexpected_body" };
}

// Only the documented JSON codes leave the body; the free text can echo the prompt.
function badRequestCode(body: Uint8Array): string {
  const parsed = json(body);
  const code = parsed.ok && isObject(parsed.value) ? parsed.value.code : null;
  return code === "validation_error" || code === "parse_error" ? code : "http_400";
}

// Undocumented, but what a scrape got back while the account was still awaiting activation.
const INACTIVE_ACCOUNT = /^customer is not active/i;

/**
 * The outcome of a scrape, a progress poll or a snapshot download. `http` is null when nothing
 * came back (timeout or network). `attempt` drives the 429 backoff when Bright Data sends no
 * Retry-After.
 */
export function classifyResponse(
  http: number | null,
  body: Uint8Array,
  headers: Headers,
  opts: { attempt?: number } = {},
): Classified {
  if (http === null) return unavailable(UNAVAILABLE_MS, "failure");
  if (http === 200) return fromOk(body);
  const retryAfter = retryAfterHeader(headers);
  // A 429 means too many running jobs, which our own pace causes; the fleet guard handles it.
  if (http === 429) {
    return {
      kind: "error",
      error: new RateLimitedError(retryAfter ?? backoffMs(opts.attempt ?? 1), "Bright Data"),
      breaker: "none",
    };
  }
  const account = ACCOUNT.get(http);
  if (account) return rejected(account, "rejected");
  if (http === 400) {
    if (INACTIVE_ACCOUNT.test(new TextDecoder().decode(body).trim())) {
      return rejected("account_inactive", "rejected");
    }
    return rejected(badRequestCode(body));
  }
  if (http === 404) return rejected("not_found");
  // Anything else short of a 4xx, a 202 without a snapshot id included, is a broken answer.
  if (http >= 500 || http < 400) return unavailable(retryAfter ?? UNAVAILABLE_MS, "failure");
  return rejected(`http_${http}`);
}
