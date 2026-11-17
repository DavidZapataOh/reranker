import {
  checkPrimitiveLatency,
  checkProviderVolume,
  checkSpendCapPressure,
  checkWorkflowBudget,
  cleanupLeases,
  type DailyStep,
  type NetworkRangesAlert,
  reconcileSpend,
  refreshNetworkRanges,
  refreshVelocityBaselines,
  reportStepError,
  type ScaleTriggerAlert,
  type WorkflowBudgetAlert,
} from "@reranker/jobs";
import { toStepError } from "@reranker/jobs/step-errors";
import { log, sendOpsAlert } from "@reranker/telemetry";
import { opsDigest } from "../ops/daily-digest";
import { launchGate } from "../ops/launch-gate";

export type DailyRunSummary = { failed: string[] };

type Alert = NetworkRangesAlert | WorkflowBudgetAlert | ScaleTriggerAlert;

const DAY_MS = 86_400_000;

const previousDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

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
    const day = previousDay(date);
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

async function checkWorkflowBudgetStep(date: string): Promise<void> {
  "use step";
  await asStep("checkWorkflowBudget", async (alerts) => {
    const month = date.slice(0, 7);
    const { estimatedEvents, spendUsd, budgetUsd, ratio } = await checkWorkflowBudget(month, {
      onAlert: (alert) => alerts.push(alert),
    });
    log.info("jobs.daily.workflow_budget", {
      month,
      estimated_events: estimatedEvents,
      spend_usd: spendUsd,
      budget_usd: budgetUsd,
      ratio,
    });
  });
}

// The latency probe takes provider slots like any call, so an open breaker can refuse it; a
// missing reading only lets the trigger lapse, and the other two triggers still run.
async function checkScaleTriggersStep(date: string): Promise<void> {
  "use step";
  await asStep("checkScaleTriggers", async (alerts) => {
    const day = previousDay(date);
    const onAlert = (alert: ScaleTriggerAlert) => alerts.push(alert);
    const pressure = await checkSpendCapPressure(day, { onAlert });
    log.info("jobs.daily.spend_cap_pressure", {
      day,
      percents: pressure.days.map((d) => Math.round(d.ratio * 100)).join(","),
      fired: pressure.fired,
    });
    try {
      const latency = await checkPrimitiveLatency({ onAlert });
      log.info("jobs.daily.primitive_latency", {
        p95_ms: latency.p95Ms,
        since: latency.since?.toISOString() ?? "",
        fired: latency.fired,
      });
    } catch (error) {
      log.warn("jobs.daily.primitive_latency_skipped", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    const month = day.slice(0, 7);
    const volume = await checkProviderVolume(month, { onAlert });
    log.info("jobs.daily.provider_volume", { month, calls: volume.calls, fired: volume.fired });
  });
}

/**
 * The daily maintenance steps, in the order they run. Each owner adds its entry at its place in
 * this list, with `run` a step function of its own module (`"use step"`, wrapping its package
 * function and rethrowing `toStepError(error)`): `purgeExpiredAuthRecords` after
 * `velocityBaseline`; `otsUpgrade`, `controlCanary`, `prewarmIntentSets`, `qualityCanary`,
 * `drainDeferredFreeReports`, `enqueueDueRemeasures` and `leadRetentionSweep` after
 * `checkScaleTriggers`; `launchGate` and `opsDigest` last, so the digest reports on everything
 * above.
 */
export const DAILY_STEPS: readonly DailyStep[] = [
  { name: "cleanupLeases", run: cleanupLeasesStep },
  { name: "refreshNetworkRanges", run: refreshNetworkRangesStep },
  { name: "velocityBaseline", run: velocityBaselineStep },
  { name: "reconcileSpend", run: reconcileSpendStep },
  { name: "checkWorkflowBudget", run: checkWorkflowBudgetStep },
  { name: "checkScaleTriggers", run: checkScaleTriggersStep },
  launchGate,
  opsDigest,
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
