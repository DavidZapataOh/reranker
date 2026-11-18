import type { SpendCaps } from "./caps";

export type CheckStatus = "pass" | "fail" | "unknown";

/** One provider tier verified against its API. Reasons are Spanish: the founder reads them. */
export type CheckResult = { id: LaunchCheckId; status: CheckStatus; reason: string };

const PROVIDER_CHECK_IDS = [
  "vercel-billing",
  "neon-production",
  "resend-plan",
  "resend-sending-key",
  "betterstack-ready",
  "betterstack-routing",
  "posthog-billing",
  "posthog-projects",
  "github-private-org",
  "traces",
  "smoke-cron",
] as const;

// Spend caps are read from the deployment's own configuration, which a repository run cannot
// load, so they are reported but never hold a flag back.
export const LAUNCH_CHECK_IDS = [...PROVIDER_CHECK_IDS, "spend-caps"] as const;

export type LaunchCheckId = (typeof LAUNCH_CHECK_IDS)[number];

/**
 * The checks each gated flag needs before it goes on in production: Vercel, Neon and Resend serve
 * both flags, everything else only the free report.
 */
export const LAUNCH_GATES = {
  "free-report-live": PROVIDER_CHECK_IDS,
  accounts: ["vercel-billing", "neon-production", "resend-plan"],
} as const satisfies Record<string, readonly LaunchCheckId[]>;

export type GatedFlag = keyof typeof LAUNCH_GATES;

export const isGatedFlag = (key: string): key is GatedFlag => Object.hasOwn(LAUNCH_GATES, key);

/** The checks of a gate that did not pass; one that could not be verified blocks like a failure. */
export function gateBlockers(results: readonly CheckResult[], flag: GatedFlag): CheckResult[] {
  const ids: readonly LaunchCheckId[] = LAUNCH_GATES[flag];
  return results.filter((r) => ids.includes(r.id) && r.status !== "pass");
}

export type Cron = { path: string; schedule: string };

/** What only the deployment, or the repository it was built from, can say about itself. */
export type LaunchInputs = {
  crons: readonly Cron[];
  /** Whether a tracer provider is registered (in the deployment) or set up (in the repository). */
  tracing: boolean;
  /** The configured `resend.emails` hourly floor; undefined when left at its default. */
  resendHourlyFloor: number | undefined;
  /** The spend caps the deployment runs with; undefined where they cannot be loaded. */
  spendCaps: SpendCaps | undefined;
};

export const pass = (id: LaunchCheckId, reason: string): CheckResult => ({
  id,
  status: "pass",
  reason,
});

export const verdict = (id: LaunchCheckId, problems: string[], ok: string): CheckResult =>
  problems.length === 0 ? pass(id, ok) : { id, status: "fail", reason: problems.join("; ") };
