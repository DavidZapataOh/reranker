import type { JobStarter } from "@reranker/jobs";
import { start } from "workflow/api";
import { jobWorkflow } from "./run";

// Every module that defines a job or opportunistic work is imported here, so it is registered
// both where jobs are enqueued and in the step bundle that runs them.
import "@reranker/evidence/jobs";

export const startJob: JobStarter = async ({ name, payload, runAt, jobId }) => {
  const run = await start(jobWorkflow, [name, payload, runAt, jobId]);
  return { runId: run.runId };
};
