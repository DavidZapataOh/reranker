import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { RetryableError } from "workflow";
import { breakerRecord } from "../src/breaker";
import { ProviderUnavailableError, RateLimitedError } from "../src/errors";
import { acquireProviderSlot, type ProviderSlot } from "../src/leases";
import { toStepError } from "../src/step-errors";
import { registerJobsTelemetry } from "../src/telemetry";
import { runWorker, startWorker } from "./support/lease-fleet";

const LANES = 5;

// The pool checkout times out after 2 s, so no process asks for more connections than it has.
beforeAll(() => {
  process.env.APP_ENV ??= "development";
  process.env.DB_POOL_MAX = "6";
});
afterAll(() => endPools());

const account = () => `test:${randomUUID()}`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const liveLeases = async (key: string): Promise<number> => {
  const { rows } = await withSystem("test.leases", (tx) =>
    tx.execute<{ n: number }>(
      sql`select count(*)::int as n from ops.concurrency_leases where key = ${key} and expires_at > clock_timestamp()`,
    ),
  );
  return rows[0]?.n ?? 0;
};

const setLeaseExpiry = (key: string, inMs: number) =>
  withSystem("test.leases", (tx) =>
    tx.execute(
      sql`update ops.concurrency_leases set expires_at = clock_timestamp() + ${inMs} * interval '1 millisecond' where key = ${key}`,
    ),
  );

describe("acquireProviderSlot", () => {
  test("200 acquisitions from 10 processes never exceed 28 live leases", async () => {
    const acct = account();
    const key = `dataforseo:${acct}`;
    let sampling = true;
    const peaks: number[] = [];
    const sampler = (async () => {
      while (sampling) {
        peaks.push(await liveLeases(key));
        await delay(50);
      }
    })();

    const workers = Array.from({ length: 10 }, () =>
      runWorker({
        account: acct,
        maxInFlight: 28,
        lanes: LANES,
        acquisitions: 20,
        // Long enough that 50 lanes fill 28 slots even when other suites load the database and
        // each acquisition takes over a second; a short hold made the peak measure throughput.
        holdMs: 2000,
      }),
    );
    // Process start-up is slow and uneven; the clock starts when all ten are loaded.
    await Promise.all(workers.map((w) => w.ready));
    for (const w of workers) w.go();
    const results = (await Promise.all(workers.map((w) => w.results))).flat();
    sampling = false;
    await sampler;

    expect(results).toHaveLength(200);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(28);
    // The pool really filled up, otherwise the bound was never tested.
    expect(Math.max(...peaks)).toBeGreaterThanOrEqual(20);
    for (const r of results) {
      if (!r.error) continue;
      expect(r.error.name).toBe("RateLimited");
      expect(r.error.retryAfterMs).toBeGreaterThan(0);
      expect(r.waitedMs).toBeGreaterThanOrEqual(5000);
    }
    expect(await liveLeases(key)).toBe(0);
  }, 60_000);

  test("callers that queue while the pool row is busy are granted by one transaction", async () => {
    const acct = account();
    const key = `dataforseo:${acct}`;
    const limits = { maxInFlight: 28, account: acct };
    await (await acquireProviderSlot("dataforseo", limits)).release();
    let all: Promise<ProviderSlot[]> | undefined;
    await withSystem("test.leases", async (tx) => {
      await tx.execute(sql`select 1 from ops.lease_pools where key = ${key} for update`);
      all = Promise.all(
        Array.from({ length: 28 }, () =>
          acquireProviderSlot("dataforseo", limits, { maxWaitMs: 20_000 }),
        ),
      );
      // Long enough for every caller to pass its breaker check and queue behind the first
      // transaction, which waits for this lock up to its 2 s lock timeout.
      await delay(1200);
    });
    const slots = (await all) ?? [];
    expect(slots).toHaveLength(28);
    // A transaction gives every lease it grants the same expiry: the first caller's, then the rest.
    const { rows } = await withSystem("test.leases", (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(distinct expires_at)::int as n from ops.concurrency_leases where key = ${key}`,
      ),
    );
    expect(rows[0]?.n).toBeLessThanOrEqual(3);
    await Promise.all(slots.map((slot) => slot.release()));
    expect(await liveLeases(key)).toBe(0);
  }, 30_000);

  test("a process that dies holding a lease frees it after the ttl", async () => {
    const acct = account();
    const child = startWorker({
      account: acct,
      maxInFlight: 1,
      lanes: 1,
      acquisitions: 1,
      holdMs: 0,
      hold: true,
    });
    await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    await expect(
      acquireProviderSlot("dataforseo", { maxInFlight: 1, account: acct }, { maxWaitMs: 0 }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    await setLeaseExpiry(`dataforseo:${acct}`, 2000);
    await delay(2100);
    const slot = await acquireProviderSlot(
      "dataforseo",
      { maxInFlight: 1, account: acct },
      { maxWaitMs: 0 },
    );
    await slot.release();
  }, 20_000);

  test("open breaker throws ProviderUnavailable with its retry", async () => {
    const acct = account();
    for (let i = 0; i < 20; i++) await breakerRecord("openai", "failure", acct);
    const error = await acquireProviderSlot("openai", { maxInFlight: 10, account: acct }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as ProviderUnavailableError).retryAfterMs).toBeGreaterThan(29_000);
    expect(await liveLeases(`openai:${acct}`)).toBe(0);
  });

  test("a half-open breaker lets one probe through and holds it for the call", async () => {
    const acct = account();
    for (let i = 0; i < 20; i++) await breakerRecord("openai", "failure", acct);
    await withSystem("test.leases", (tx) =>
      tx.execute(
        sql`update ops.breaker_state set open_until = clock_timestamp() - interval '1 millisecond' where provider = 'openai' and account = ${acct}`,
      ),
    );
    const probe = await acquireProviderSlot("openai", { maxInFlight: 10, account: acct });
    await expect(
      acquireProviderSlot("openai", { maxInFlight: 10, account: acct }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    const { rows } = await withSystem("test.leases", (tx) =>
      tx.execute<{ held_ms: number }>(
        sql`select extract(epoch from probe_until - clock_timestamp()) * 1000 as held_ms from ops.breaker_state where provider = 'openai' and account = ${acct}`,
      ),
    );
    expect(Number(rows[0]?.held_ms)).toBeGreaterThan(125_000);
    await probe.release();
  });

  test("rpm bucket is enforced atomically with the lease", async () => {
    const acct = account();
    const limits = { maxInFlight: 1, rpm: 5, account: acct };
    const first = await acquireProviderSlot("dataforseo", limits, { maxWaitMs: 0 });
    // Denied for the slot, so it must not spend a token.
    await expect(
      acquireProviderSlot("dataforseo", limits, { maxWaitMs: 0 }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    await first.release();
    for (let i = 0; i < 4; i++) {
      await (await acquireProviderSlot("dataforseo", limits, { maxWaitMs: 0 })).release();
    }
    const error = await acquireProviderSlot("dataforseo", limits, { maxWaitMs: 0 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RateLimitedError);
    // 5 per minute refills one token every 12 s, less what the round trips already refilled.
    expect((error as RateLimitedError).retryAfterMs).toBeGreaterThan(0);
    expect((error as RateLimitedError).retryAfterMs).toBeLessThanOrEqual(12_000);
    expect(await liveLeases(`dataforseo:${acct}`)).toBe(0);
  });

  test("a token cost spends the tpm bucket", async () => {
    const acct = account();
    const limits = { maxInFlight: 5, tpm: 1000, account: acct };
    await (
      await acquireProviderSlot("openai", limits, { cost: { tokens: 800 }, maxWaitMs: 0 })
    ).release();
    await expect(
      acquireProviderSlot("openai", limits, { cost: { tokens: 800 }, maxWaitMs: 0 }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  test("a waiter takes the slot a release frees and reports how long it waited", async () => {
    const acct = account();
    const limits = { maxInFlight: 1, account: acct };
    const held = await acquireProviderSlot("dataforseo", limits);
    const events: unknown[] = [];
    registerJobsTelemetry({ capture: (event) => void events.push(event), alert: async () => {} });
    setTimeout(() => void held.release(), 500);
    const slot = await acquireProviderSlot("dataforseo", limits, { maxWaitMs: 5000 });
    await slot.release();
    registerJobsTelemetry(null);
    expect(events).toEqual([
      {
        name: "jobs.lease.wait_ms",
        props: { provider: "dataforseo", wait_ms: expect.any(Number) },
      },
    ]);
    const waited = (events[0] as { props: { wait_ms: number } }).props.wait_ms;
    expect(waited).toBeGreaterThanOrEqual(450);
    expect(waited).toBeLessThan(3000);
  });

  test("database unavailable surfaces a retryable error and never calls the provider", async () => {
    const call = vi.fn();
    const url = process.env.DATABASE_URL_SYSTEM;
    await endPools();
    process.env.DATABASE_URL_SYSTEM = "postgres://nobody:nothing@127.0.0.1:1/none";
    try {
      await expect(
        acquireProviderSlot("dataforseo", { maxInFlight: 28 }).then(call),
      ).rejects.toSatisfy((e) => RetryableError.is(toStepError(e)));
    } finally {
      await endPools();
      if (url === undefined) delete process.env.DATABASE_URL_SYSTEM;
      else process.env.DATABASE_URL_SYSTEM = url;
    }
    expect(call).not.toHaveBeenCalled();
  });

  test("release is idempotent", async () => {
    const acct = account();
    const slot = await acquireProviderSlot("dataforseo", { maxInFlight: 2, account: acct });
    expect(await liveLeases(`dataforseo:${acct}`)).toBe(1);
    await slot.release();
    await slot.release();
    expect(await liveLeases(`dataforseo:${acct}`)).toBe(0);
  });
});
