import { fetchWithin } from "../digest";
import { checkBetterStackReady, checkBetterStackRouting } from "./betterstack";
import { spendCapsCheck } from "./caps";
import { checkSmokeCron, checkTraces } from "./deployment";
import { checkEvidenceAuditTrail, checkEvidenceSigningKey, checkQtsaBalance } from "./evidence";
import { checkGitHubRepo } from "./github";
import { checkNeonProduction } from "./neon";
import { checkPostHogBilling, checkPostHogProjects } from "./posthog";
import { checkResend } from "./resend";
import { type CheckResult, LAUNCH_CHECK_IDS, type LaunchCheckId, type LaunchInputs } from "./types";
import { checkVercelBilling } from "./vercel";

export { checkBetterStackReady, checkBetterStackRouting } from "./betterstack";
export { type SpendCaps, spendCapsCheck } from "./caps";
export { checkSmokeCron, checkTraces, repositoryInputs, tracerRegistered } from "./deployment";
export { checkEvidenceAuditTrail, checkEvidenceSigningKey, checkQtsaBalance } from "./evidence";
export { checkGitHubRepo } from "./github";
export { checkNeonProduction } from "./neon";
export { checkPostHogBilling, checkPostHogProjects } from "./posthog";
export { checkResend } from "./resend";
export {
  type CheckResult,
  type CheckStatus,
  type Cron,
  type GatedFlag,
  gateBlockers,
  isGatedFlag,
  LAUNCH_CHECK_IDS,
  LAUNCH_GATES,
  type LaunchCheckId,
  type LaunchInputs,
} from "./types";
export { checkVercelBilling } from "./vercel";

async function within(
  id: LaunchCheckId,
  fn: (signal: AbortSignal) => Promise<CheckResult>,
): Promise<CheckResult> {
  const result = await fetchWithin(fn);
  return result.ok ? result.value : { id, status: "unknown", reason: result.detail ?? "sin dato" };
}

/**
 * Verifies every launch stage against its provider, read-only and in parallel, each bounded so a
 * provider that does not answer is `unknown` instead of holding the rest. Never rejects.
 */
export async function runLaunchCheck(inputs: LaunchInputs): Promise<CheckResult[]> {
  const [
    vercel,
    resend,
    neon,
    ready,
    routing,
    billing,
    projects,
    github,
    signingKey,
    auditTrail,
    qtsa,
  ] = await Promise.all([
    within("vercel-billing", checkVercelBilling),
    fetchWithin(() => checkResend(inputs.resendHourlyFloor)),
    within("neon-production", checkNeonProduction),
    within("betterstack-ready", checkBetterStackReady),
    within("betterstack-routing", checkBetterStackRouting),
    within("posthog-billing", checkPostHogBilling),
    within("posthog-projects", checkPostHogProjects),
    within("github-private-org", checkGitHubRepo),
    within("evidence-signing-key", checkEvidenceSigningKey),
    within("evidence-audit-trail", checkEvidenceAuditTrail),
    within("qtsa-balance", () => checkQtsaBalance()),
  ]);
  const [plan, key] = resend.ok
    ? resend.value
    : (["resend-plan", "resend-sending-key"] as const).map(
        (id): CheckResult => ({ id, status: "unknown", reason: resend.detail ?? "sin dato" }),
      );
  const byId = new Map(
    [
      vercel,
      neon,
      plan,
      key,
      ready,
      routing,
      billing,
      projects,
      github,
      signingKey,
      auditTrail,
      qtsa,
      checkTraces(inputs.tracing),
      checkSmokeCron(inputs.crons),
      inputs.spendCaps
        ? spendCapsCheck(inputs.spendCaps)
        : {
            id: "spend-caps" as const,
            status: "unknown" as const,
            reason: "solo lo verifica el despliegue",
          },
    ].flatMap((r) => (r ? [[r.id, r] as const] : [])),
  );
  return LAUNCH_CHECK_IDS.map(
    (id) => byId.get(id) ?? { id, status: "unknown", reason: "sin dato" },
  );
}
