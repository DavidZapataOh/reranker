import { type DailyStep, reportStepError } from "@reranker/jobs";
import { toStepError } from "@reranker/jobs/step-errors";
import { log, sendOpsAlert } from "@reranker/telemetry";
import { fetchWithin } from "@reranker/telemetry/digest";
import type { GatedFlag } from "@reranker/telemetry/launch";

const ids = (results: { id: string }[]) => results.map((r) => r.id).join(",");

/**
 * Verifies the launch stages from inside production and alerts when a gated flag is on while a
 * stage it needs is failing (critical) or could not be verified (warning). `flags:sync` refuses to
 * turn such a flag on; this catches one turned on in PostHog directly, or a stage that regressed.
 */
export async function runLaunchGate(): Promise<void> {
  // Loaded here, not at the top: every step of the bundle would otherwise pay for the provider
  // clients on its cold start.
  const [{ gateBlockers, runLaunchCheck }, { deploymentInputs, readGatedFlags }] =
    await Promise.all([import("@reranker/telemetry/launch"), import("../../lib/launch-state")]);
  const [checks, flags] = await Promise.all([
    runLaunchCheck(deploymentInputs()),
    fetchWithin(() => readGatedFlags()),
  ]);
  log.info("jobs.daily.launch_gate", {
    fail: ids(checks.filter((c) => c.status === "fail")),
    unknown: ids(checks.filter((c) => c.status === "unknown")),
    ...(flags.ok ? flags.value : {}),
  });
  if (!flags.ok) {
    // Without the flags the gate cannot be enforced; as an error it reaches the exceptions alert.
    log.error("ops.launch_gate.flags_unreadable", { detail: flags.detail ?? "sin dato" });
    return;
  }
  for (const [flag, on] of Object.entries(flags.value) as [GatedFlag, boolean][]) {
    if (!on) continue;
    const blockers = gateBlockers(checks, flag);
    if (blockers.length === 0) continue;
    const failing = blockers.filter((b) => b.status === "fail");
    await sendOpsAlert("launch-gate-violated", {
      flag,
      failing: ids(failing),
      unknown: ids(blockers.filter((b) => b.status === "unknown")),
      reasons: blockers.map((b) => `${b.id}: ${b.reason}`).join("; "),
      severity: failing.length > 0 ? "critical" : "warning",
    });
  }
}

async function launchGateStep(_date: string): Promise<void> {
  "use step";
  try {
    await runLaunchGate();
  } catch (error) {
    await reportStepError("daily", "launchGate", error);
    throw toStepError(error);
  }
}

/** Runs before the digest, so a violation is alerted on its own and the digest only lists it. */
export const launchGate: DailyStep = { name: "launchGate", run: launchGateStep };
