import {
  checkWorkflowQuota,
  cleanupLeases,
  type DailyStep,
  type NetworkRangesAlert,
  reconcileSpend,
  refreshNetworkRanges,
  refreshVelocityBaselines,
  reportStepError,
  type WorkflowQuotaAlert,
} from "@reranker/jobs";
import { toStepError } from "@reranker/jobs/step-errors";
import { log, sendOpsAlert } from "@reranker/telemetry";

export type DailyRunSummary = { failed: string[] };

type Alert = NetworkRangesAlert | WorkflowQuotaAlert;

const DAY_MS = 86_400_000;

// Every step maps its failure to the retry the cause asks for, and sends the alerts it collected
// even when it fails: an alert about a failure is the point of collecting it.
async function asStep<T>(step: string, work: (alerts: Alert[]) => Promise<T>): Promise<T> {
  const alerts: Alert[] = [];
  try {
    return await work(alerts);
  } catch (error) {
    await reportStepError("daily", step, error);
    throw toStepError(error);
  } finally {
    await Promise.all(alerts.map((alert) => sendOpsAlert(alert.kind, alert.payload)));
  }
}

async function cleanupLeasesStep(_date: string): Promise<void> {
  "use step";
  await asStep("cleanupLeases", async () => log.info("jobs.daily.cleanup", await cleanupLeases()));
}

async function refreshNetworkRangesStep(_date: string): Promise<void> {
  "use step";
  await asStep("refreshNetworkRanges", async (alerts) => {
    const { applied, rows, added, removed, changed, commit } = await refreshNetworkRanges(fetch, {
      onAlert: (alert) => alerts.push(alert),
    });
    log.info("jobs.daily.network_ranges", { applied, rows, added, removed, changed, commit });
  });
}

async function velocityBaselineStep(_date: string): Promise<void> {
  "use step";
  await asStep("velocityBaseline", async () =>
    log.info("jobs.daily.velocity_baselines", { keys: await refreshVelocityBaselines() }),
  );
}

// The run starts early in the morning, so the day to close is the one that just ended.
async function reconcileSpendStep(date: string): Promise<void> {
  "use step";
  await asStep("reconcileSpend", async () => {
    const day = new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
    const { released, mismatches } = await reconcileSpend(day);
    log.info("jobs.daily.spend_reconciled", { day, released, mismatches: mismatches.length });
    // As errors they reach PostHog as exceptions, where the exceptions alert already watches.
    for (const { provider, ledger, provider_reported } of mismatches) {
      log.error("jobs.spend.mismatch", {
        day,
        provider,
        currency: ledger.currency,
        ledger_micros: ledger.amount_micros,
        provider_micros: provider_reported.amount_micros,
      });
    }
  });
}

async function checkWorkflowQuotaStep(date: string): Promise<void> {
  "use step";
  await asStep("checkWorkflowQuota", async (alerts) => {
    const month = date.slice(0, 7);
    const { estimatedEvents, ratio } = await checkWorkflowQuota(month, {
      onAlert: (alert) => alerts.push(alert),
    });
    log.info("jobs.daily.workflow_quota", { month, estimated_events: estimatedEvents, ratio });
  });
}

/**
 * The daily maintenance steps, in the order they run. Each owner adds its entry at its place in
 * this list, with `run` a step function of its own module (`"use step"`, wrapping its package
 * function and rethrowing `toStepError(error)`): `purgeExpiredAuthRecords` after
 * `velocityBaseline`; `otsUpgrade`, `controlCanary`, `prewarmIntentSets`, `qualityCanary`,
 * `drainDeferredFreeReports`, `enqueueDueRemeasures` and `leadRetentionSweep` after
 * `checkWorkflowQuota`; `opsDigest` last, so it reports on everything above.
 */
export const DAILY_STEPS: readonly DailyStep[] = [
  { name: "cleanupLeases", run: cleanupLeasesStep },
  { name: "refreshNetworkRanges", run: refreshNetworkRangesStep },
  { name: "velocityBaseline", run: velocityBaselineStep },
  { name: "reconcileSpend", run: reconcileSpendStep },
  { name: "checkWorkflowQuota", run: checkWorkflowQuotaStep },
];

async function reportDailyStepFailure(name: string, date: string, error: string): Promise<void> {
  "use step";
  log.error("jobs.daily.step_failed", { step: name, date, error });
}

/**
 * Runs the steps in order. A step that still fails after its retries is logged and the next one
 * runs, unless it is critical: then the run fails with its error.
 */
export async function runDailySteps(
  steps: readonly DailyStep[],
  date: string,
): Promise<DailyRunSummary> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run(date);
    } catch (error) {
      failed.push(step.name);
      await reportDailyStepFailure(
        step.name,
        date,
        error instanceof Error ? error.message : String(error),
      );
      if (step.critical) throw error;
    }
  }
  return { failed };
}

/** The once-a-day run the cron starts for a Bogota date (`YYYY-MM-DD`). */
export async function dailyMaintenanceWorkflow(date: string): Promise<DailyRunSummary> {
  "use workflow";

  return runDailySteps(DAILY_STEPS, date);
}
