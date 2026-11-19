import { defineJob, enqueue } from "@reranker/jobs";
import { integrate, MAX_BATCH_ENTRIES } from "./log/integrate";

type LogPayload = { origin: string };

const BUSY_RETRY_MS = 5_000;

/**
 * Integration runs at most once a minute, a minute after the first entry that needs it: every
 * caller in the same minute shares one job.
 */
export async function scheduleIntegration(origin: string, now: Date): Promise<void> {
  const minute = Math.floor(now.getTime() / 60_000);
  await enqueue(
    integrateJob,
    { origin },
    { dedupeKey: `int-${minute}`, runAt: new Date((minute + 1) * 60_000) },
  );
}

/** Appends every pending entry of `origin` to the transparency log and signs a checkpoint. */
export const integrateJob = defineJob<LogPayload>({
  name: "evidence.integrate",
  handler: async ({ origin }) => {
    const result = await integrate(origin);
    if (result.status === "busy") {
      // The integrator holding the lock may have read the queue before this job's entries landed.
      const runAt = new Date(Date.now() + BUSY_RETRY_MS);
      await enqueue(
        integrateJob,
        { origin },
        { dedupeKey: `int-busy-${Math.floor(runAt.getTime() / BUSY_RETRY_MS)}`, runAt },
      );
      return;
    }
    if (result.status === "empty") return;
    await enqueue(publishJob, { origin }, { dedupeKey: `pub-${result.treeSize}` });
    // A full batch may have left entries behind; they wait for the next minute's checkpoint.
    if (result.treeSize - result.firstIndex === MAX_BATCH_ENTRIES) {
      await scheduleIntegration(origin, new Date());
    }
  },
});

/** Publishes the tiles and checkpoint of every integrated batch of `origin` not yet public. */
export const publishJob = defineJob<LogPayload>({
  name: "evidence.publish",
  // Integrated batches stay unpublished until the publisher ships; its first run publishes them
  // all, oldest first.
  handler: async () => {
    throw new Error("The transparency log publisher is not available in this deployment");
  },
});
