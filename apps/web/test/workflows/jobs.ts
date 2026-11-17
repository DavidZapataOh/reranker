import { defineJob } from "@reranker/jobs";
import { record } from "./ledger";

// Directive-free on purpose: a workflow file keeps its top-level code, and these handlers reach
// Node APIs that the workflow sandbox refuses. Steps that import this file register the jobs.

export const recordingJob = defineJob<{ id: string }>({
  name: "test.recording",
  handler: async ({ id }, { attempt }) => record(id, { event: "executed", attempt }),
});

export const failingJob = defineJob<{ id: string }>({
  name: "test.failing",
  maxAttempts: 2,
  handler: async ({ id }, { attempt }) => {
    await record(id, { event: "attempt", attempt });
    throw new Error("always fails");
  },
});
