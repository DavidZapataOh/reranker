import { withSystem } from "@reranker/db";
import { isAppError } from "@reranker/schema";
import { sql } from "drizzle-orm";
import { breakerCheck } from "./breaker";
import { loadJobsConfig } from "./config";
import { InvalidInputError, ProviderUnavailableError, RateLimitedError } from "./errors";
import { assertOpaqueKey } from "./keys";
import type { JobPriority, PaidProvider, ProviderLimits } from "./providers";
import { emit } from "./telemetry";

/** Held until `release`; a function that dies holding one frees it when the ttl lapses. */
export interface ProviderSlot {
  release(): Promise<void>;
}

export interface AcquireOptions {
  cost?: { requests?: number; tokens?: number };
  /** Defaults to the inline wait of the jobs config; the free report passes the time it has left. */
  maxWaitMs?: number;
  /** Order among the callers of this instance waiting for the same pool; `normal` by default. */
  priority?: JobPriority;
}

// A call is cut at 115 s and a step ends within 150 s; the extra 15 s covers the release.
const CALL_TIMEOUT_MS = 115_000;
const LEASE_TTL_MS = CALL_TIMEOUT_MS + 15_000;

/** The key of a provider account's lease pool and rate buckets. */
export const leasePoolKey = (provider: PaidProvider, account?: string): string =>
  `${provider}:${account ?? "default"}`;

const FIRST_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 1000;
// Below the 5 s statement timeout, so a longer caller wait is spent over several attempts.
const MAX_LOCK_WAIT_MS = 2000;
const LOCK_NOT_AVAILABLE = "55P03";

const RANK: Record<JobPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

// Half to all of the step, so instances denied together do not come back together.
const backoff = (attempt: number) =>
  Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** attempt) * (0.5 + Math.random() / 2);

interface Bucket {
  key: string;
  capacity: number;
  refillPerSecond: number;
}

// One batch takes the buckets for all of its callers, so every caller of a pool names the same
// ones; a caller without a token estimate costs the tpm bucket nothing.
function bucketsOf(poolKey: string, { rpm, tpm }: ProviderLimits): Bucket[] {
  const out: Bucket[] = [];
  if (rpm !== undefined) {
    out.push({ key: `${poolKey}:rpm`, capacity: rpm, refillPerSecond: rpm / 60 });
  }
  if (tpm !== undefined) {
    out.push({ key: `${poolKey}:tpm`, capacity: tpm, refillPerSecond: tpm / 60 });
  }
  return out;
}

function costsOf(buckets: Bucket[], limits: ProviderLimits, cost: AcquireOptions["cost"]) {
  const costs: number[] = [];
  if (limits.rpm !== undefined) costs.push(cost?.requests ?? 1);
  if (limits.tpm !== undefined) costs.push(cost?.tokens ?? 0);
  buckets.forEach((b, i) => {
    const c = costs[i] as number;
    if (!(Number.isFinite(b.capacity) && b.capacity > 0 && c >= 0 && c <= b.capacity)) {
      throw new InvalidInputError("Provider cost must fit within the provider rate limit");
    }
  });
  return costs;
}

// Drizzle expands a bare array into a list; a param binds it as one array value.
const array = (values: Array<string | number>) => sql.param(values);

type GrantRow = { lease_id: string | null; retry_after_ms: number };

interface Waiter {
  rank: number;
  costs: number[];
  deadline: number;
  /** In a transaction whose answer has not come back: only that answer may settle it. */
  asked: boolean;
  expired: boolean;
  grant(leaseId: string): void;
  deny(error: unknown): void;
}

interface Release {
  leaseId: string;
  done(): void;
}

/**
 * The callers of one provider account on this instance. The database serializes every acquirer
 * of a pool on its row, so sending them one at a time admitted one lease per round trip however
 * many slots were free. Instead one transaction at a time frees the leases released since the
 * last one and grants as many waiting callers as fit, in priority order: one row lock and one
 * round trip for the whole queue, and no connection held by a caller while it waits.
 */
class LeasePool {
  private readonly queue: Waiter[] = [];
  private releases: Release[] = [];
  private running = false;
  private wake: (() => void) | undefined;
  // What the last denial said; a caller whose wait runs out between attempts is told the same.
  private hint = MAX_BACKOFF_MS;

  private readonly key: string;
  private readonly limits: ProviderLimits;
  private readonly buckets: Bucket[];

  constructor(key: string, limits: ProviderLimits) {
    this.key = key;
    this.limits = limits;
    this.buckets = bucketsOf(key, limits);
  }

  acquire(costs: number[], rank: number, maxWaitMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (waiter.asked) {
          waiter.expired = true;
          return;
        }
        this.remove(waiter);
        reject(new RateLimitedError(this.hint));
      }, maxWaitMs);
      const waiter: Waiter = {
        rank,
        costs,
        deadline: Date.now() + maxWaitMs,
        asked: false,
        expired: false,
        grant: (leaseId) => {
          clearTimeout(timer);
          resolve(leaseId);
        },
        deny: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      // Behind every waiting caller of the same or a higher priority.
      const at = this.queue.findIndex((w) => w.rank > rank);
      this.queue.splice(at === -1 ? this.queue.length : at, 0, waiter);
      this.start();
    });
  }

  release(leaseId: string): Promise<void> {
    return new Promise<void>((done) => {
      this.releases.push({ leaseId, done });
      this.wake?.();
      this.start();
    });
  }

  private remove(waiter: Waiter): void {
    const at = this.queue.indexOf(waiter);
    if (at !== -1) this.queue.splice(at, 1);
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    // Callers arriving in the same tick join the first transaction instead of waiting behind it.
    queueMicrotask(() => void this.drain());
  }

  private async drain(): Promise<void> {
    try {
      let denials = 0;
      while (this.queue.length > 0 || this.releases.length > 0) {
        const batch = this.queue.slice(0, this.limits.maxInFlight);
        const released = this.releases;
        this.releases = [];
        for (const waiter of batch) waiter.asked = true;
        let leases: string[] = [];
        let failure: { error: unknown } | undefined;
        try {
          leases = await this.take(batch, released);
        } catch (error) {
          failure = { error };
        }
        batch.forEach((waiter, i) => {
          waiter.asked = false;
          const leaseId = leases[i];
          if (leaseId === undefined && !failure && !waiter.expired) return;
          this.remove(waiter);
          if (leaseId !== undefined) waiter.grant(leaseId);
          else waiter.deny(failure ? failure.error : new RateLimitedError(this.hint));
        });
        if (failure || leases.length === batch.length) {
          // Room was found, so an old denial no longer says when a slot frees.
          if (!failure && batch.length > 0) this.hint = MAX_BACKOFF_MS;
          denials = 0;
          continue;
        }
        // The pool is full: this instance's releases wake it, other instances' are only seen by
        // asking again.
        if (this.queue.length > 0 && this.releases.length === 0) await this.pause(denials++);
      }
    } finally {
      this.running = false;
    }
  }

  private pause(attempt: number): Promise<void> {
    return new Promise<void>((resume) => {
      const timer = setTimeout(resume, backoff(attempt));
      this.wake = () => {
        clearTimeout(timer);
        resume();
      };
    }).finally(() => {
      this.wake = undefined;
    });
  }

  /** The leases granted to the head of `batch`, in its order; `released` are settled either way. */
  private async take(batch: Waiter[], released: Release[]): Promise<string[]> {
    // As long as the most patient caller of the batch may still wait.
    const waitLeftMs = Math.max(0, ...batch.map((w) => w.deadline - Date.now()));
    const lockTimeoutMs = Math.min(Math.max(1, Math.ceil(waitLeftMs)), MAX_LOCK_WAIT_MS);
    const b = this.buckets;
    let rows: GrantRow[];
    try {
      ({ rows } = await withSystem(
        "jobs.lease",
        (tx) =>
          tx.execute<GrantRow>(
            sql`select * from ops.acquire_slots(${this.key}, ${this.limits.maxInFlight}::int, ${LEASE_TTL_MS}::int, ${batch.length}::int, ${array(released.map((r) => r.leaseId))}::uuid[], ${array(b.map((x) => x.key))}::text[], ${array(b.map((x) => x.capacity))}::float8[], ${array(b.map((x) => x.refillPerSecond))}::float8[], ${array(batch.flatMap((w) => w.costs))}::float8[])`,
          ),
        { lockTimeoutMs },
      ));
    } catch (error) {
      const cause = isAppError(error) ? (error.cause as { code?: string } | undefined) : undefined;
      if (cause?.code === LOCK_NOT_AVAILABLE) {
        // Rolled back with the rest, so the next transaction frees them.
        this.releases.unshift(...released);
        this.hint = MAX_BACKOFF_MS;
        return [];
      }
      // The call each slot was for already ran; the ttl frees what could not be released.
      if (released.length > 0) {
        console.error("[jobs] lease release failed", { code: (error as { code?: unknown }).code });
      }
      for (const r of released) r.done();
      throw error;
    }
    for (const r of released) r.done();
    if (batch.length > 0 && rows.length === 0) throw new Error("acquire_slots returned no row");
    const denial = rows.find((row) => row.lease_id === null);
    if (denial) this.hint = denial.retry_after_ms;
    return rows.flatMap((row) => (row.lease_id ? [row.lease_id] : []));
  }
}

const pools = new Map<string, LeasePool>();

function poolOf(poolKey: string, limits: ProviderLimits): LeasePool {
  // Callers configured with other limits for the same account queue apart; the row still holds
  // them all to its latest limit.
  const id = [poolKey, limits.maxInFlight, limits.rpm, limits.tpm].join("|");
  let pool = pools.get(id);
  if (!pool) {
    pool = new LeasePool(poolKey, limits);
    pools.set(id, pool);
  }
  return pool;
}

/**
 * Admission to one provider account: breaker, then a concurrency lease and the rate buckets taken
 * together. A busy slot is awaited up to `maxWaitMs`; after that the caller gets `RateLimited` and
 * the step runtime retries at the delay given.
 */
export async function acquireProviderSlot(
  provider: PaidProvider,
  limits: ProviderLimits,
  opts: AcquireOptions = {},
): Promise<ProviderSlot> {
  const poolKey = leasePoolKey(provider, limits.account);
  assertOpaqueKey(poolKey);
  const maxWaitMs = opts.maxWaitMs ?? loadJobsConfig().maxInlineWaitMs;
  const priority = opts.priority ?? "normal";
  if (!Object.hasOwn(RANK, priority)) throw new InvalidInputError(`Unknown priority ${priority}`);
  const costs = costsOf(bucketsOf(poolKey, limits), limits, opts.cost);
  const startedAt = Date.now();

  // A half-open probe makes the very call this slot is for, so it is held as long as the lease.
  const breaker = await breakerCheck(provider, limits.account, LEASE_TTL_MS);
  if (breaker.state === "open") throw new ProviderUnavailableError(provider, breaker.retryAfterMs);

  const pool = poolOf(poolKey, limits);
  let leaseId: string;
  try {
    leaseId = await pool.acquire(costs, RANK[priority], maxWaitMs);
  } catch (error) {
    if (error instanceof RateLimitedError) emit({ name: "jobs.lease.denied", props: { provider } });
    throw error;
  }
  emit({ name: "jobs.lease.wait_ms", props: { provider, wait_ms: Date.now() - startedAt } });
  let released: Promise<void> | undefined;
  return {
    release() {
      released ??= pool.release(leaseId);
      return released;
    },
  };
}
