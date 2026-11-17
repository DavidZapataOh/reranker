import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  defineJob,
  enqueue,
  type JobStarter,
  registerJobStarter,
  registerOpportunistic,
  runOpportunistic,
} from "../src/jobs";

// Concurrency is real only with more connections than the default three of the system pool.
beforeAll(() => {
  process.env.DB_POOL_MAX = "20";
});
afterAll(() => endPools());

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const unique = (label: string) => `${label}-${randomUUID()}`;

const job = defineJob<{ a: number }>({ name: "test.dedupe", handler: async () => undefined });
const otsJob = defineJob<void>({ name: "test.ots", handler: async () => undefined });

let starter: ReturnType<typeof vi.fn<JobStarter>>;
beforeEach(() => {
  starter = vi.fn<JobStarter>(async () => {
    await delay(100);
    return { runId: `wrun_${randomUUID()}` };
  });
  registerJobStarter(starter);
});

describe("enqueue", () => {
  test("concurrent enqueue with the same dedupe key starts one job", async () => {
    const key = unique("d1");
    const out = await Promise.all(
      Array.from({ length: 10 }, () => enqueue(job, { a: 1 }, { dedupeKey: key })),
    );
    expect(starter).toHaveBeenCalledTimes(1);
    expect(starter).toHaveBeenCalledWith({
      name: job.name,
      payload: { a: 1 },
      runAt: null,
      jobId: `${job.name}:${key}`,
    });
    expect(new Set(out.map((o) => o.jobId))).toEqual(new Set([`${job.name}:${key}`]));
    expect(out.filter((o) => o.created)).toHaveLength(1);
  });

  test("a later enqueue with the same key reuses the run and runAt travels as an instant", async () => {
    const key = unique("later");
    const runAt = new Date(Date.now() + 60_000);
    await expect(enqueue(job, { a: 2 }, { dedupeKey: key, runAt })).resolves.toEqual({
      jobId: `${job.name}:${key}`,
      created: true,
    });
    expect(starter.mock.calls[0]?.[0].runAt).toBe(runAt.toISOString());
    await expect(enqueue(job, { a: 2 }, { dedupeKey: key })).resolves.toEqual({
      jobId: `${job.name}:${key}`,
      created: false,
    });
    expect(starter).toHaveBeenCalledTimes(1);
  });
});

describe("runOpportunistic", () => {
  test("opportunistic work runs at most once per interval fleet-wide", async () => {
    const name = unique("otsUpgrade");
    registerOpportunistic(name, otsJob, { minIntervalMs: 60_000 });
    const names = await Promise.all(Array.from({ length: 5 }, () => runOpportunistic()));
    expect(names.flat()).toEqual([name]);
    expect(starter).toHaveBeenCalledTimes(1);
    expect(starter.mock.calls[0]?.[0]).toMatchObject({ name: otsJob.name, runAt: null });
    expect(await runOpportunistic()).toEqual([]);
  });

  test("runs again once the interval has passed", async () => {
    const name = unique("interval");
    registerOpportunistic(name, otsJob, { minIntervalMs: 60_000 });
    expect(await runOpportunistic()).toEqual([name]);
    await withSystem("test.jobs", (tx) =>
      tx.execute(
        sql`update ops.opportunistic_runs set last_run_at = last_run_at - interval '61 seconds'
             where name = ${name}`,
      ),
    );
    expect(await runOpportunistic()).toEqual([name]);
    expect(starter).toHaveBeenCalledTimes(2);
    const [first, second] = starter.mock.calls.map(([input]) => input.jobId);
    expect(first).not.toBe(second);
  });
});
