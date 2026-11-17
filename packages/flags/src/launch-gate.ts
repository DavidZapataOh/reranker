import {
  type CheckResult,
  type GatedFlag,
  gateBlockers,
  isGatedFlag,
  LAUNCH_GATES,
} from "@reranker/telemetry/launch";
import type { PostHogApi, RemoteFlag } from "./posthog-api";

type Property = NonNullable<
  NonNullable<NonNullable<NonNullable<RemoteFlag["filters"]>["groups"]>[number]["properties"]>
>[number];

// Flags are evaluated with an `env` person property (see evaluate.ts); a condition on any other
// property may still match someone in production.
function allowsProduction(p: Property): boolean {
  if (p.key !== "env") return true;
  const values = Array.isArray(p.value) ? p.value : [p.value];
  if ((p.operator ?? "exact") === "exact") return values.includes("production");
  if (p.operator === "is_not") return !values.includes("production");
  return true;
}

/** Whether the flag can be on for someone in production, from its definition. */
export function enabledInProduction(flag: RemoteFlag): boolean {
  if (!flag.active) return false;
  return (flag.filters?.groups ?? []).some(
    (g) => (g.rollout_percentage ?? 100) > 0 && (g.properties ?? []).every(allowsProduction),
  );
}

/** Each gated flag as PostHog would serve it in production. */
export async function gatedFlagsOn(api: PostHogApi): Promise<Record<GatedFlag, boolean>> {
  const flags = await api.listFlags();
  const on = (key: GatedFlag) => flags.some((f) => f.key === key && enabledInProduction(f));
  return Object.fromEntries(
    (Object.keys(LAUNCH_GATES) as GatedFlag[]).map((key) => [key, on(key)]),
  ) as Record<GatedFlag, boolean>;
}

/**
 * Turns a flag on. A gated flag goes on only when every launch check of its gate passes; a check
 * that could not be verified refuses like a failure.
 */
export async function runEnable(
  api: PostHogApi,
  key: string,
  check: () => Promise<readonly CheckResult[]>,
  log: (line: string) => void = console.log,
): Promise<boolean> {
  const flag = (await api.listFlags()).find((f) => f.key === key);
  if (!flag) {
    log(`::error::${key} does not exist in PostHog: run flags:sync first`);
    return false;
  }
  if (isGatedFlag(key)) {
    const blockers = gateBlockers(await check(), key);
    if (blockers.length > 0) {
      log(`::error::refusing to enable ${key}: launch stages not verified`);
      for (const b of blockers) log(`  ${b.id}: ${b.status}: ${b.reason}`);
      return false;
    }
  }
  await api.setActive(flag.id, true);
  log(`enabled ${key}`);
  return true;
}
