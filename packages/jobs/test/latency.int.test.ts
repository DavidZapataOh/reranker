import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { cost } from "@reranker/schema";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, onTestFinished, test, vi } from "vitest";
import { loadJobsConfig } from "../src/config";
import { spendDay } from "../src/day";
import { SpendCapExceededError } from "../src/errors";
import { type LatencyStats, probeSpendPath, summarize } from "../src/latency";
import { reserveSpend, type SpendReservation, spendStatus } from "../src/spend";
import { runWorker } from "./support/lease-fleet";

// The largest pool the database package allows: nineteen reservations in flight at once and one
// connection for the lease sampler, so no call queues in pg-pool behind its 2 s checkout timeout.
const CONNECTIONS = 19;
beforeAll(() => {
  process.env.APP_ENV ??= "development";
  process.env.DB_POOL_MAX = String(CONNECTIONS + 1);
});
afterAll(() => endPools());

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("CI latency guard", () => {
  // CI runners sit tens of milliseconds from Neon, so an absolute budget would measure the
  // network. Each primitive is held instead to the round trip of an empty system transaction
  // measured in the same run: a few of them plus headroom, which only a gross regression (a
  // lock wait, a scan, an extra round trip) breaks. The strict p95 < 25 ms is measured from
  // iad1 on the preview through /api/internal/jobs-latency.
  // About 20 round trips per call: 100 calls take ~50 s from a runner ~20 ms from Neon.
  const CALLS = 100;
  // Transactions each primitive makes: the slot checks the breaker, then takes the lease.
  const TRANSACTIONS = { acquireProviderSlot: 2, reserveSpend: 1, settleSpend: 1 } as const;
  const ceiling = (base: LatencyStats, transactions: number) => transactions * 2 * base.p50 + 15;

  test(`p50 of ${CALLS} calls per primitive stays within its round trips`, async () => {
    const samples: number[] = [];
    for (let i = 0; i < CALLS; i++) {
      const startedAt = performance.now();
      await withSystem("test.latency", (tx) => tx.execute(sql`select 1`));
      samples.push(performance.now() - startedAt);
    }
    const base = summarize(samples);
    const report = await probeSpendPath(CALLS);
    console.info("[jobs latency]", JSON.stringify({ emptyTransaction: base, ...report }));

    for (const [name, transactions] of Object.entries(TRANSACTIONS)) {
      const stats = report[name as keyof typeof TRANSACTIONS];
      expect(stats.n).toBe(CALLS);
      expect(stats.p50, name).toBeLessThanOrEqual(ceiling(base, transactions));
    }
  }, 180_000);
});

describe("10x load", () => {
  // Ten reports at once ask for 1,200 slots over their run. Here ten times their concurrency (50
  // lanes in 5 processes) asks 300 times for DataForSEO's 28 slots, while 600 reservations race
  // for a contract-test cap that admits 250 of them. Few processes, many lanes each: booting a
  // process costs a CPU-second that the suites running beside this one on the runner need.
  // Each process grants its waiting lanes together, a transaction at a time, so slots held for
  // 2 s fill all 28 and the ceiling is always reached.
  const SLOT_LIMIT = 28;
  const HOLD_MS = 2000;
  const RESERVATIONS = 600;
  const AMOUNT = 2_000;

  test("600 reservations and 300 slot requests neither over-grant nor fail untyped", async () => {
    // A spend day no other test or earlier run on the same database uses, so the cap starts empty.
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const [year, dayOfYear] = [Math.floor(Math.random() * 100), Math.floor(Math.random() * 365)];
    vi.setSystemTime(new Date(Date.UTC(2900 + year, 0, 1 + dayOfYear, 17)));
    const cap = loadJobsConfig().caps["purpose:contract-test"].amount_micros;
    const admitted = Math.floor(cap / AMOUNT);
    expect(admitted).toBeLessThan(RESERVATIONS);

    const account = `test:${randomUUID()}`;
    const key = `dataforseo:${account}`;
    const liveLeases = async () => {
      const { rows } = await withSystem("test.latency", (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from ops.concurrency_leases where key = ${key} and expires_at > clock_timestamp()`,
        ),
      );
      return rows[0]?.n ?? 0;
    };
    let sampling = true;
    const peaks: number[] = [];
    const sampler = (async () => {
      while (sampling) {
        peaks.push(await liveLeases());
        await delay(50);
      }
    })();

    const fleet = Array.from({ length: 5 }, () =>
      runWorker({ account, maxInFlight: SLOT_LIMIT, lanes: 10, acquisitions: 60, holdMs: HOLD_MS }),
    );
    await Promise.all(fleet.map((w) => w.ready));
    for (const w of fleet) w.go();

    const outcomes: PromiseSettledResult<SpendReservation>[] = [];
    let next = 0;
    const lane = async () => {
      for (let i = next++; i < RESERVATIONS; i = next++) {
        outcomes[i] = await reserveSpend({
          provider: "dataforseo",
          purpose: "contract-test",
          refType: "load-test",
          refId: randomUUID(),
          estimate: cost(AMOUNT, "USD"),
        }).then(
          (value) => ({ status: "fulfilled", value }),
          (reason: unknown) => ({ status: "rejected", reason }),
        );
      }
    };
    await Promise.all(Array.from({ length: CONNECTIONS }, lane));
    const slots = (await Promise.all(fleet.map((w) => w.results))).flat();
    sampling = false;
    await sampler;

    const granted = outcomes.filter((o) => o.status === "fulfilled");
    const denied = outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason] : []));
    expect(granted).toHaveLength(admitted);
    expect(denied).toHaveLength(RESERVATIONS - admitted);
    for (const error of denied) {
      expect(error).toBeInstanceOf(SpendCapExceededError);
      expect(error).toMatchObject({ scope: "purpose:contract-test" });
    }
    const [global, purpose] = await spendStatus(["global", "purpose:contract-test"]);
    expect(purpose?.used.amount_micros).toBe(admitted * AMOUNT);
    expect(global?.used.amount_micros).toBe(admitted * AMOUNT);
    expect(spendDay()).toMatch(/^29\d\d-/);

    expect(slots).toHaveLength(300);
    // The pool filled up to its ceiling, otherwise the ceiling was never tested, and never past it.
    expect(Math.max(...peaks)).toBe(SLOT_LIMIT);
    for (const slot of slots) {
      if (!slot.error) continue;
      expect(slot.error).toMatchObject({ name: "RateLimited" });
      expect(slot.error.retryAfterMs).toBeGreaterThan(0);
    }
    expect(await liveLeases()).toBe(0);
  }, 120_000);
});
