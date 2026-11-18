import { type DailyStep, reportStepError } from "@reranker/jobs";
import { toStepError } from "@reranker/jobs/step-errors";
import { log, sendOpsAlert } from "@reranker/telemetry";
import { fetchWithin } from "@reranker/telemetry/digest";
import { checkVercelBilling } from "@reranker/telemetry/launch";

/**
 * Alerts when the Vercel team is blocked, off an active paid plan, or reranker.co answers 402.
 * A blocked team stops this run too, so the uptime monitors are what catch the block itself; this
 * catches a plan that stopped being active before Vercel blocks the team.
 */
export async function runVercelBillingCheck(): Promise<void> {
  const result = await fetchWithin(checkVercelBilling);
  const check = result.ok
    ? result.value
    : { status: "unknown" as const, reason: result.detail ?? "sin dato" };
  log.info("jobs.daily.vercel_billing", { status: check.status });
  if (check.status === "fail") await sendOpsAlert("vercel-billing", { reason: check.reason });
  else if (check.status === "unknown") {
    log.warn("ops.vercel_billing.unverified", { reason: check.reason });
  }
}

async function vercelBillingStep(_date: string): Promise<void> {
  "use step";
  try {
    await runVercelBillingCheck();
  } catch (error) {
    await reportStepError("daily", "vercelBilling", error);
    throw toStepError(error);
  }
}

export const vercelBilling: DailyStep = { name: "vercelBilling", run: vercelBillingStep };
