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
import { entriesOf } from "./workflows/ledger";

const unique = () => `job-${randomUUID()}`;

beforeAll(() => registerJobStarter(startJob));
afterAll(() => endPools());

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

async function executedAt(id: string): Promise<Date> {
  const [entry] = await entriesOf(id, "executed");
  if (!entry) throw new Error(`${id} never ran`);
  return new Date(entry.at);
}

test("runAt is respected within ±2 s", async () => {
  const id = unique();
  const runAt = new Date(Date.now() + 5000);
  const { jobId } = await enqueue(recordingJob, { id }, { dedupeKey: id, runAt });
  await (await runOf(jobId)).returnValue;
  expect(Math.abs((await executedAt(id)).getTime() - runAt.getTime())).toBeLessThanOrEqual(2000);
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
