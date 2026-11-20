import { anchorLatest, announceKeys, logOrigin, upgradePendingOts } from "@reranker/evidence";
import { reportStepError } from "@reranker/jobs";
import { toStepError } from "@reranker/jobs/step-errors";
import { log } from "@reranker/telemetry";

export type HourlyEvidenceSummary = { failed: string[] };

async function asStep<T>(step: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await reportStepError("evidence-hourly", step, error);
    throw toStepError(error);
  }
}

// A new key is announced on the first hour a deployment pinning it runs; afterwards this step
// only reads that its entries exist.
async function announceKeysStep(hourKey: string): Promise<void> {
  "use step";
  await asStep("announceKeys", async () => {
    const { announced } = await announceKeys();
    if (announced.length > 0)
      log.info("evidence.hourly.keys_announced", { hour: hourKey, announced });
  });
}

async function anchorLatestStep(hourKey: string): Promise<void> {
  "use step";
  await asStep("anchorLatest", async () => {
    const result = await anchorLatest(logOrigin());
    if (result.treeSize === null) {
      log.info("evidence.hourly.anchor", { hour: hourKey, tree_size: "none" });
      return;
    }
    log.info("evidence.hourly.anchor", {
      hour: hourKey,
      tree_size: result.treeSize,
      ots: result.ots,
      ...result.tsa,
    });
  });
}

async function upgradePendingOtsStep(hourKey: string): Promise<void> {
  "use step";
  await asStep("upgradePendingOts", async () => {
    const { checked, confirmed, overdue } = await upgradePendingOts();
    log.info("evidence.hourly.ots_upgrade", { hour: hourKey, checked, confirmed, overdue });
  });
}

async function reportHourlyStepFailure(
  name: string,
  hourKey: string,
  error: string,
): Promise<void> {
  "use step";
  log.error("evidence.hourly.step_failed", { step: name, hour: hourKey, error });
}

const HOURLY_STEPS = [
  { name: "announceKeys", run: announceKeysStep },
  { name: "anchorLatest", run: anchorLatestStep },
  { name: "upgradePendingOts", run: upgradePendingOtsStep },
] as const;

/**
 * The hourly evidence run for `hourKey` (`YYYY-MM-DDTHH`, UTC): logs any signing key not announced
 * yet, anchors the newest checkpoint, then upgrades waiting OpenTimestamps proofs. No step depends
 * on another, so one that still fails after its retries is logged and the others run anyway.
 */
export async function hourlyEvidenceWorkflow(hourKey: string): Promise<HourlyEvidenceSummary> {
  "use workflow";

  const failed: string[] = [];
  for (const step of HOURLY_STEPS) {
    try {
      await step.run(hourKey);
    } catch (error) {
      failed.push(step.name);
      await reportHourlyStepFailure(
        step.name,
        hourKey,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { failed };
}
