import {
  type DailyStep,
  enqueue,
  RateLimitedError,
  runBatch,
  SpendCapExceededError,
} from "@reranker/jobs";
import { toStepError } from "@reranker/jobs/step-errors";
import { FatalError, getStepMetadata } from "workflow";
import { type DailyRunSummary, runDailySteps } from "@/workflows/maintenance/daily";
import { recordingJob } from "./jobs";
import { entriesOf, monotonicNow, record } from "./ledger";

const ITEMS = Array.from({ length: 12 }, (_, i) => String(i));
const FLAKY_ITEM = "7";

/** Twelve items in one step; item 7 is rate limited on the first attempt only. */
export async function batchResumeWorkflow(runKey: string): Promise<void> {
  "use workflow";

  await runItems(runKey);
}

async function runItems(runKey: string): Promise<void> {
  "use step";
  const { attempt } = getStepMetadata();
  const results = await runBatch(
    ITEMS,
    async (item) => {
      await record(runKey, { event: "call", item, attempt });
      if (item === FLAKY_ITEM && attempt === 1) throw new RateLimitedError(1000);
      await record(runKey, { event: "stored", item });
      return item;
    },
    {
      key: (item) => item,
      isDone: async (key) =>
        (await entriesOf(runKey, "stored")).some((entry) => entry.item === key) ? key : null,
      concurrency: 4,
    },
  );
  const failed = results.find((result) => !result.ok);
  if (failed && !failed.ok) throw toStepError(failed.error);
}

/** One step that fails on its first attempt, to measure when the retry happens. */
export async function retryTimingWorkflow(
  runKey: string,
  mode: "rate" | "cap",
): Promise<{ gapMs: number }> {
  "use workflow";

  return failOnce(runKey, mode);
}

async function failOnce(runKey: string, mode: "rate" | "cap"): Promise<{ gapMs: number }> {
  "use step";
  const { attempt } = getStepMetadata();
  await record(runKey, { event: "attempt", attempt });
  if (attempt === 1) {
    throw toStepError(
      mode === "rate"
        ? new RateLimitedError(7000)
        : new SpendCapExceededError("global", new Date(Date.now() + 60_000)),
    );
  }
  const [first] = await entriesOf(runKey, "attempt");
  return { gapMs: monotonicNow() - (first?.monotonicAt ?? monotonicNow()) };
}

/** Enqueues from inside a run, as domain workflows do, where only the process-wide starter exists. */
export async function enqueueFromRunWorkflow(id: string): Promise<string> {
  "use workflow";

  return enqueueRecording(id);
}

async function enqueueRecording(id: string): Promise<string> {
  "use step";
  const { jobId } = await enqueue(recordingJob, { id }, { dedupeKey: id });
  return jobId;
}

// The daily steps receive the date; here it carries the run key, so each step writes to the ledger.

async function firstDailyStep(runKey: string): Promise<void> {
  "use step";
  await record(runKey, { event: "ran", item: "first" });
}

async function brokenDailyStep(runKey: string): Promise<void> {
  "use step";
  await record(runKey, { event: "ran", item: "broken" });
  throw new FatalError("broken on purpose");
}

async function lastDailyStep(runKey: string): Promise<void> {
  "use step";
  await record(runKey, { event: "ran", item: "last" });
}

const stepsWith = (critical: boolean): readonly DailyStep[] => [
  { name: "first", run: firstDailyStep },
  { name: "broken", run: brokenDailyStep, critical },
  { name: "last", run: lastDailyStep },
];

/** The daily loop over a step list whose middle step fails, critical or not. */
export async function dailyStepsWorkflow(
  runKey: string,
  critical: boolean,
): Promise<DailyRunSummary> {
  "use workflow";

  return runDailySteps(stepsWith(critical), runKey);
}
