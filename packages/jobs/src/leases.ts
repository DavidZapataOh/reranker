import { withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { breakerCheck } from "./breaker";
import { loadJobsConfig } from "./config";
import { InvalidInputError, ProviderUnavailableError, RateLimitedError } from "./errors";
import { assertOpaqueKey } from "./keys";
import type { PaidProvider, ProviderLimits } from "./providers";

/** Held until `release`; a function that dies holding one frees it when the ttl lapses. */
export interface ProviderSlot {
  release(): Promise<void>;
}

export type LeaseEvent =
  | { name: "jobs.lease.wait_ms"; props: { provider: PaidProvider; wait_ms: number } }
  | { name: "jobs.lease.denied"; props: { provider: PaidProvider } };

export interface AcquireOptions {
  cost?: { requests?: number; tokens?: number };
  /** Defaults to the inline wait of the jobs config; the free report passes the time it has left. */
  maxWaitMs?: number;
  onEvent?: (event: LeaseEvent) => void;
}

// A call is cut at 115 s and a step ends within 150 s; the extra 15 s covers the release.
const CALL_TIMEOUT_MS = 115_000;
const LEASE_TTL_MS = CALL_TIMEOUT_MS + 15_000;

const FIRST_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 1000;

type SlotRow = { lease_id: string | null; retry_after_ms: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Half to all of the step, so callers denied together do not come back together.
const backoff = (attempt: number) =>
  Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** attempt) * (0.5 + Math.random() / 2);

interface Bucket {
  key: string;
  capacity: number;
  refillPerSecond: number;
  cost: number;
}

function buckets(poolKey: string, limits: ProviderLimits, cost: AcquireOptions["cost"]): Bucket[] {
  const out: Bucket[] = [];
  const { rpm, tpm } = limits;
  if (rpm !== undefined) {
    out.push({
      key: `${poolKey}:rpm`,
      capacity: rpm,
      refillPerSecond: rpm / 60,
      cost: cost?.requests ?? 1,
    });
  }
  if (tpm !== undefined && cost?.tokens !== undefined) {
    out.push({
      key: `${poolKey}:tpm`,
      capacity: tpm,
      refillPerSecond: tpm / 60,
      cost: cost.tokens,
    });
  }
  for (const b of out) {
    const valid =
      Number.isFinite(b.capacity) && b.capacity > 0 && b.cost >= 0 && b.cost <= b.capacity;
    if (!valid)
      throw new InvalidInputError("Provider cost must fit within the provider rate limit");
  }
  return out;
}

// Drizzle expands a bare array into a list; a param binds it as one array value.
const array = (values: Array<string | number>) => sql.param(values);

/**
 * Admission to one provider account: breaker, then a concurrency lease and the rate buckets taken
 * together in one statement. A busy slot is awaited up to `maxWaitMs`; after that the caller gets
 * `RateLimited` and the step runtime retries at the delay given.
 */
export async function acquireProviderSlot(
  provider: PaidProvider,
  limits: ProviderLimits,
  opts: AcquireOptions = {},
): Promise<ProviderSlot> {
  const poolKey = `${provider}:${limits.account ?? "default"}`;
  assertOpaqueKey(poolKey);
  const maxWaitMs = opts.maxWaitMs ?? loadJobsConfig().maxInlineWaitMs;
  const taken = buckets(poolKey, limits, opts.cost);
  const startedAt = Date.now();

  // A half-open probe makes the very call this slot is for, so it is held as long as the lease.
  const breaker = await breakerCheck(provider, limits.account, LEASE_TTL_MS);
  if (breaker.state === "open") throw new ProviderUnavailableError(provider, breaker.retryAfterMs);

  for (let attempt = 0; ; attempt++) {
    const { rows } = await withSystem("jobs.lease", (tx) =>
      tx.execute<SlotRow>(
        sql`select * from ops.acquire_slot(${poolKey}, ${limits.maxInFlight}::int, ${LEASE_TTL_MS}::int, ${array(taken.map((b) => b.key))}::text[], ${array(taken.map((b) => b.capacity))}::float8[], ${array(taken.map((b) => b.refillPerSecond))}::float8[], ${array(taken.map((b) => b.cost))}::float8[])`,
      ),
    );
    const row = rows[0];
    if (!row) throw new Error("acquire_slot returned no row");
    if (row.lease_id) {
      opts.onEvent?.({
        name: "jobs.lease.wait_ms",
        props: { provider, wait_ms: Date.now() - startedAt },
      });
      return slotFor(row.lease_id);
    }
    // A full pool reports when its earliest lease would expire, an upper bound that a release
    // beats by far, so the wait polls until the deadline instead of trusting the hint.
    const remaining = maxWaitMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      opts.onEvent?.({ name: "jobs.lease.denied", props: { provider } });
      throw new RateLimitedError(row.retry_after_ms);
    }
    await sleep(Math.min(backoff(attempt), remaining));
  }
}

function slotFor(leaseId: string): ProviderSlot {
  let released: Promise<void> | undefined;
  return {
    release() {
      // The call this slot was for already ran; a failed release must not hide its outcome, and
      // the ttl frees the slot anyway.
      released ??= withSystem("jobs.lease", (tx) =>
        tx.execute(sql`delete from ops.concurrency_leases where lease_id = ${leaseId}::uuid`),
      ).then(
        () => undefined,
        (error: unknown) => {
          console.error("[jobs] lease release failed", {
            code: (error as { code?: unknown }).code,
          });
        },
      );
      return released;
    },
  };
}
