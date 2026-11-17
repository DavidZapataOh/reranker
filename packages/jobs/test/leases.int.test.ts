import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { endPools, withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { RetryableError } from "workflow";
import { breakerRecord } from "../src/breaker";
import { ProviderUnavailableError, RateLimitedError } from "../src/errors";
import { acquireProviderSlot } from "../src/leases";
import { toStepError } from "../src/step-errors";
import type { WorkerJob, WorkerResult } from "./support/lease-worker";

const WORKER = fileURLToPath(new URL("./support/lease-worker.ts", import.meta.url));
const LANES = 5;

// The pool checkout times out after 2 s, so no process asks for more connections than it has.
beforeAll(() => {
  process.env.APP_ENV ??= "development";
  process.env.DB_POOL_MAX = "6";
});
afterAll(() => endPools());

const account = () => `test:${randomUUID()}`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function startWorker(job: WorkerJob): ChildProcess {
  return fork(WORKER, [JSON.stringify(job)], {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, DB_POOL_MAX: String(LANES + 1) },
  });
}

function runWorker(job: WorkerJob): Promise<WorkerResult[]> {
  const child = startWorker(job);
  return new Promise((resolve, reject) => {
    child.once("message", (m: { results: WorkerResult[] }) => resolve(m.results));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`worker exited with ${code}`)));
  });
}

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
        holdMs: 400,
      }),
    );
    const results = (await Promise.all(workers)).flat();
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
    // 5 per minute refills one token every 12 s.
    expect((error as RateLimitedError).retryAfterMs).toBeGreaterThan(10_000);
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
    setTimeout(() => void held.release(), 500);
    const slot = await acquireProviderSlot("dataforseo", limits, {
      maxWaitMs: 5000,
      onEvent: (e) => events.push(e),
    });
    await slot.release();
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
