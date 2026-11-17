import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { workflowStarts } from "@reranker/db/schema";
import { enqueue, registerJobStarter } from "@reranker/jobs";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { getRun, start } from "workflow/api";
import { startJob } from "@/workflows/jobs/registry";
import { enqueueFromRunWorkflow } from "./workflows/fixtures";
import { failingJob, recordingJob } from "./workflows/jobs";
import { entriesOf, monotonicNow } from "./workflows/ledger";

const unique = () => `job-${randomUUID()}`;

// enqueue answers with the job id; the run behind it is the one startOnce recorded.
async function runOf(jobId: string) {
  const [row] = await withSystem("test.jobs", (tx) =>
    tx
      .select({ runId: workflowStarts.runId })
      .from(workflowStarts)
      .where(and(eq(workflowStarts.kind, "job"), eq(workflowStarts.key, jobId))),
  );
  if (!row?.runId) throw new Error(`No run recorded for ${jobId}`);
  return getRun(row.runId);
}

async function executedAt(id: string) {
  const [entry] = await entriesOf(id, "executed");
  if (!entry) throw new Error(`${id} never ran`);
  return entry;
}

// The first run in a worker imports the workflow bundle, which takes seconds on a busy runner:
// a one-off cost of the test process, not scheduling delay, so it is paid before any timing.
beforeAll(async () => {
  registerJobStarter(startJob);
  const id = unique();
  const { jobId } = await enqueue(recordingJob, { id }, { dedupeKey: id });
  await (await runOf(jobId)).returnValue;
}, 60_000);
afterAll(() => endPools());

// A wait's timer is queued with a delay in whole seconds, rounded up, so the run may wake up to a
// second after runAt; waking it and starting the job's step is one delivery and one replay.
const TIMER_RESOLUTION_MS = 1000;
const WAKE_BUDGET_MS = 1000;

test("a job never starts before runAt and starts within the timer resolution after it", async () => {
  const id = unique();
  const runAt = new Date(Date.now() + 5000);
  const due = monotonicNow() + 5000;
  const { jobId } = await enqueue(recordingJob, { id }, { dedupeKey: id, runAt });
  await (await runOf(jobId)).returnValue;
  const executed = await executedAt(id);
  expect(executed.at).toBeGreaterThanOrEqual(runAt.getTime());
  expect(executed.monotonicAt - due).toBeLessThanOrEqual(TIMER_RESOLUTION_MS + WAKE_BUDGET_MS);
});

test("a failing job is retried with the attempt in ctx and stops at maxAttempts", async () => {
  const id = unique();
  const { jobId } = await enqueue(failingJob, { id }, { dedupeKey: id });
  await expect((await runOf(jobId)).returnValue).rejects.toThrow(/JobAttemptsExhausted/);
  expect((await entriesOf(id, "attempt")).map((entry) => entry.attempt)).toEqual([1, 2]);
});

test("a job enqueued inside a run starts through the process-wide starter", async () => {
  const id = unique();
  const run = await start(enqueueFromRunWorkflow, [id]);
  const jobId = await run.returnValue;
  expect(jobId).toBe(`${recordingJob.name}:${id}`);
  await (await runOf(jobId)).returnValue;
  expect((await entriesOf(id, "executed")).map((entry) => entry.attempt)).toEqual([1]);
});
