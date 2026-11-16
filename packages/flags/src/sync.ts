import { renderFlagKeys } from "../scripts/gen";
import type { CreateFlagPayload, PostHogApi, RemoteFlag } from "./posthog-api";
import type { RegistryEntry } from "./registry";

/** A new flag starts off; paid providers are on only where the evaluating env is production. */
export function flagPayload(entry: RegistryEntry): CreateFlagPayload {
  return {
    key: entry.key,
    name: entry.description,
    active: false,
    filters: {
      groups: [
        entry.productionOnly
          ? {
              properties: [
                { key: "env", type: "person", operator: "exact", value: ["production"] },
              ],
              rollout_percentage: 100,
            }
          : { properties: [], rollout_percentage: 100 },
      ],
    },
    tags: [entry.kind, entry.owner],
  };
}

/** Only creates: a flag that exists in PostHog belongs to PostHog, where people tune it. */
export function planSync(
  registry: readonly RegistryEntry[],
  remote: readonly RemoteFlag[],
): { create: CreateFlagPayload[] } {
  const existing = new Set(remote.map((flag) => flag.key));
  return { create: registry.filter((e) => !existing.has(e.key)).map(flagPayload) };
}

/** Problems that fail the check: a registry key PostHog lacks, or a generated file out of date. */
export function checkFlags(
  registry: readonly RegistryEntry[],
  remote: readonly RemoteFlag[],
  genFile: string,
): string[] {
  const existing = new Set(remote.map((flag) => flag.key));
  const problems = registry
    .filter((entry) => !existing.has(entry.key))
    .map((entry) => `missing in PostHog: ${entry.key}`);
  if (genFile !== renderFlagKeys(registry)) {
    problems.push("flag-keys.gen.ts is stale: run pnpm --filter @reranker/flags flags:gen");
  }
  return problems;
}

/** Release flags past their expiry: a reminder to remove them, never a failure. */
export function expiredReleases(registry: readonly RegistryEntry[], today: Date): string[] {
  const day = today.toISOString().slice(0, 10);
  return registry
    .filter((e) => e.kind === "release" && e.expires !== undefined && e.expires < day)
    .map((e) => `release flag ${e.key} expired on ${e.expires}: remove it`);
}

export async function runSync(
  api: PostHogApi,
  registry: readonly RegistryEntry[],
  options: { dryRun: boolean },
  log: (line: string) => void = console.log,
): Promise<number> {
  const { create } = planSync(registry, await api.listFlags());
  for (const payload of create) {
    log(`${options.dryRun ? "would create" : "create"} ${payload.key}`);
    if (!options.dryRun) await api.createFlag(payload);
  }
  log(`create: ${create.length}`);
  return create.length;
}

/** True when the registry, the generated file and PostHog agree; warnings never change that. */
export async function runCheck(
  api: PostHogApi,
  registry: readonly RegistryEntry[],
  genFile: string,
  today: Date,
  log: (line: string) => void = console.log,
): Promise<boolean> {
  for (const warning of expiredReleases(registry, today)) log(`::warning::${warning}`);
  const problems = checkFlags(registry, await api.listFlags(), genFile);
  for (const problem of problems) log(`::error::${problem}`);
  return problems.length === 0;
}
