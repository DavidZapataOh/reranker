import { RateLimitedError, runBatch, SpendCapExceededError } from "@reranker/jobs";
import { toStepError } from "@reranker/jobs/step-errors";
import { getStepMetadata } from "workflow";
import { entriesOf, record } from "./ledger";

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
  return { gapMs: Date.now() - (first?.at ?? Date.now()) };
}
