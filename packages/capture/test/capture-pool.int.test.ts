import { withSystem } from "@reranker/db";
import type { EngineId } from "@reranker/schema";
import { log } from "@reranker/telemetry";
import { sql } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { systemPool } from "../../db/src/client";
import { captureSlots } from "../src/capture";
import { frozen, installCaptureHarness, ledger, provider, rowsOf } from "./support/capture-harness";

vi.mock("../../evidence/src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));
vi.mock("@reranker/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/flags")>()),
  assertCaptureAllowed: vi.fn(async () => undefined),
}));

// A report function runs with the pools every deployed instance has: three system connections,
// each waited for at most two seconds.
installCaptureHarness({ deployedPools: true });

// About what one R2 write round takes from iad1.
const R2_WRITE_MS = 250;
// A transaction from iad1 takes a few milliseconds. Every capture runs several, so a runner whose
// transactions take much longer needs more connection time than three connections give 600
// captures before their deadline, whatever the capture path does.
const IAD1_LIKE_TX_MS = 30;
const CYCLE: EngineId[] = ["gemini", "google-ai-overview", "google-ai-mode"];
const cycle = (n: number) => Array.from({ length: n }, (_, i) => CYCLE[i % 3] as EngineId);

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;

/** The median of a few one-statement system transactions on warm connections. */
async function transactionMs(): Promise<number> {
  const once = async () => {
    const startedAt = performance.now();
    await withSystem("capture.test", (tx) => tx.execute(sql`select 1`));
    return performance.now() - startedAt;
  };
  await Promise.all([once(), once(), once()]);
  const samples: number[] = [];
  for (let i = 0; i < 7; i++) samples.push(await once());
  return percentile(
    samples.sort((a, b) => a - b),
    50,
  );
}

/** DataForSEO calls counted in the error-rate and parse windows of the capture alerts. */
async function alertWindows(): Promise<{ errors: number; parse: number }> {
  const { rows } = await withSystem("capture.test", (tx) =>
    tx.execute<{ errors: number; parse: number }>(
      sql`select coalesce(sum(count) filter (where key = 'capture:dataforseo:errors'), 0)::int as errors,
                 coalesce(sum(count) filter (where key = 'capture:dataforseo:parse'), 0)::int as parse
            from ops.velocity_buckets
           where key in ('capture:dataforseo:errors', 'capture:dataforseo:parse')`,
    ),
  );
  return rows[0] ?? { errors: 0, parse: 0 };
}
const alertWindowCalls = async () => (await alertWindows()).errors;

/** How long each system connection checked out from now on is held, in milliseconds. */
function recordHolds(pool: ReturnType<typeof systemPool>): { holds: number[]; stop: () => void } {
  const holds: number[] = [];
  const since = new Map<object, number>();
  const acquire = (client: object) => since.set(client, performance.now());
  const release = (_: Error | undefined, client: object) => {
    const start = since.get(client);
    if (start !== undefined) holds.push(performance.now() - start);
    since.delete(client);
  };
  pool.on("acquire", acquire);
  pool.on("release", release);
  return {
    holds,
    stop: () => {
      pool.off("acquire", acquire);
      pool.off("release", release);
    },
  };
}

test("a capture alone takes eight system transactions, its settle riding the insert of its row", async () => {
  const { m, ids } = await frozen(cycle(2));
  const spend = { purpose: "contract-test" as const, refType: "capture-test", refId: m };
  const before = await alertWindowCalls();
  await captureSlots(m, ids.slice(0, 1), { mode: "live", spend });
  // The first capture's alert windows are written after it returns; they must not be counted.
  await vi.waitFor(async () => expect(await alertWindowCalls()).toBe(before + 1));
  const { holds, stop } = recordHolds(systemPool());
  await captureSlots(m, ids.slice(1), { mode: "live", spend });
  // Besides the capture, the run reads which slots already succeeded. The capture: breaker
  // check, lease, reservation, breaker record, lease release, retry check, row and settle, and
  // its alert windows, written after the call.
  // Each probe of the window is one checkout of its own, left out of the count.
  let probes = 0;
  await vi
    .waitFor(async () => {
      probes += 1;
      expect(await alertWindowCalls()).toBe(before + 2);
    })
    .finally(stop);
  const transactions = holds.length - 1 - probes;
  console.info(`one capture: ${transactions} system transactions`);
  expect(transactions).toBeLessThanOrEqual(8);
  expect(await ledger(m)).toEqual({ settled: 2 });
});

test("10× load on three system connections: none is held across R2, and none times out at iad1 distance", async () => {
  const pool = systemPool();
  expect(pool.options.max).toBe(3);
  const txMs = await transactionMs();
  // Longer than the two-statement transaction that stores a row and settles it, so a connection
  // held across a write cannot pass for one.
  const r2WriteMs = Math.max(R2_WRITE_MS, 4 * txMs);
  provider.delayMs = 20;
  provider.r2WriteMs = r2WriteMs;
  const reports = await Promise.all([0, 1, 2].map(() => frozen(cycle(200))));
  const windowsBefore = await alertWindows();
  const warn = vi.spyOn(log, "warn");
  const error = vi.spyOn(console, "error");
  const deadlineAt = Date.now() + 85_000;
  const { holds, stop } = recordHolds(pool);
  const startedAt = performance.now();
  const outs = await Promise.all(
    reports.map(({ m, ids }) =>
      captureSlots(m, ids, {
        mode: "live",
        spend: { purpose: "contract-test", refType: "capture-test", refId: m },
        deadlineAt,
      }),
    ),
  );
  const elapsedMs = performance.now() - startedAt;
  const failed = outs.flatMap((o) => o.failed);
  // The alert windows are written after the calls; every call must reach them, none lost to the
  // pool. Each probe is a checkout of its own, left out of the count.
  let probes = 0;
  const windows = await vi
    .waitFor(
      async () => {
        probes += 1;
        const now = await alertWindows();
        expect(now.errors - windowsBefore.errors).toBe(provider.calls.length);
        return now;
      },
      { timeout: 30_000, interval: 250 },
    )
    .finally(stop);
  const velocityFailures = warn.mock.calls.filter(
    ([message]) => message === "capture.velocity_failed",
  );
  warn.mockRestore();
  const breakerFailures = error.mock.calls.filter(
    ([message]) => message === "[jobs] breaker record (dataforseo) failed",
  );
  error.mockRestore();
  const checkoutsPerCall = (holds.length - probes) / Math.max(1, provider.calls.length);

  holds.sort((a, b) => a - b);
  console.info(
    `10× capture on 3 system connections, transaction ${txMs.toFixed(1)} ms, R2 write ` +
      `${r2WriteMs.toFixed(0)} ms: ${(elapsedMs / 1000).toFixed(2)} s, ${failed.length} failed; ` +
      `${holds.length} checkouts held p50 ${percentile(holds, 50).toFixed(1)} ms, ` +
      `p95 ${percentile(holds, 95).toFixed(1)} ms, p99 ${percentile(holds, 99).toFixed(1)} ms, ` +
      `max ${percentile(holds, 100).toFixed(1)} ms, ` +
      `${checkoutsPerCall.toFixed(2)} checkouts per call, alert windows included`,
  );
  expect(velocityFailures).toEqual([]);
  // A full pool delays breaker outcomes; none of the burst's is lost.
  expect(breakerFailures).toEqual([]);
  // Batched, the alert windows cost a burst less than one checkout per call.
  expect(checkoutsPerCall).toBeLessThanOrEqual(7);
  // Every capture writes to R2 once; were a connection held across that, one checkout of each
  // capture's few would last longer than the write.
  expect(percentile(holds, 99)).toBeLessThan(r2WriteMs);
  // Whatever failed, no slot was called twice.
  expect(provider.calls.length).toBeLessThanOrEqual(600);
  if (txMs > IAD1_LIKE_TX_MS) {
    console.info(`A transaction takes ${txMs.toFixed(1)} ms here, too far to stand in for iad1`);
    return;
  }
  expect(failed).toEqual([]);
  expect(provider.calls).toHaveLength(600);
  expect(windows.parse - windowsBefore.parse).toBe(600);
  for (const { m } of reports) {
    expect(await ledger(m)).toEqual({ settled: 200 });
    expect(await rowsOf(m)).toHaveLength(200);
  }
}, 300_000);
