import { registerJobStarter, runJob, runOpportunistic } from "@reranker/jobs";
import { toStepError } from "@reranker/jobs/step-errors";
import { getStepMetadata, sleep } from "workflow";
import { startJob } from "./registry";

/** The run behind defineJob and enqueue: wait for runAt, run the job, then give opportunistic work a turn. */
export async function jobWorkflow(
  name: string,
  payload: unknown,
  runAt: string | null,
  jobId: string,
): Promise<void> {
  "use workflow";

  if (runAt !== null) await sleep(new Date(runAt));
  await runJobStep(name, payload, jobId);
  await runOpportunisticStep();
}

// Steps run on their own copy of every module, so each one registers the starter itself and,
// through the registry, loads the job modules. Used only inside steps, the import stays out of
// the workflow sandbox.

async function runJobStep(name: string, payload: unknown, jobId: string): Promise<void> {
  "use step";
  registerJobStarter(startJob);
  try {
    await runJob(name, payload, getStepMetadata().attempt, jobId);
  } catch (error) {
    throw toStepError(error);
  }
}
// runJob ends a job at its own maxAttempts; this only bounds the largest one a job may ask for.
runJobStep.maxRetries = 9;

async function runOpportunisticStep(): Promise<void> {
  "use step";
  registerJobStarter(startJob);
  await runOpportunistic();
}
