import { appEnv } from "@reranker/env";
import type { CaptureChannel, CaptureProvider, EngineId } from "@reranker/schema";
import type { FeatureFlagEvaluations } from "posthog-node";
import { definitionsReady, getFlagsClient, remembered } from "./client";
import type { FlagKey } from "./flag-keys.gen";

export type FlagContext =
  | { kind: "system"; channel?: CaptureChannel; provider?: CaptureProvider; engine?: EngineId }
  | { kind: "tenant"; tenantId: string; plan?: string; country?: string }
  | { kind: "house"; country?: string };

// No own-browser capture ships yet: a flag flipped on by mistake must not open it.
const ALWAYS_OFF: ReadonlySet<FlagKey> = new Set(["capture-channel-ui-own"]);

function subject(ctx: FlagContext): { distinctId: string; properties: Record<string, string> } {
  const { kind, ...rest } = ctx;
  const properties: Record<string, string> = { env: appEnv() };
  for (const [name, value] of Object.entries(rest)) {
    if (value !== undefined) properties[name === "tenantId" ? "tenant_id" : name] = value;
  }
  const distinctId = ctx.kind === "tenant" ? `tenant:${ctx.tenantId}` : kind;
  return { distinctId, properties };
}

/** Evaluates `keys` from the definitions in memory, or returns undefined when none are loaded. */
export async function evaluate(
  keys: readonly FlagKey[],
  ctx: FlagContext,
): Promise<FeatureFlagEvaluations | undefined> {
  if (!definitionsReady()) return undefined;
  const { distinctId, properties } = subject(ctx);
  const id = `${keys.join(",")}|${distinctId}|${JSON.stringify(properties)}`;
  return remembered(id, () =>
    getFlagsClient().evaluateFlags(distinctId, {
      flagKeys: [...keys],
      personProperties: properties,
      onlyEvaluateLocally: true,
    }),
  );
}

/** Reads a flag from an evaluation; a key PostHog does not define reads off. */
export function on(flags: FeatureFlagEvaluations, key: FlagKey): boolean {
  return !ALWAYS_OFF.has(key) && flags.isEnabled(key, { sendFeatureFlagEvents: false });
}

/** Whether `key` is on for `ctx`; off while definitions are not loaded (fail-closed). */
export async function isEnabled(key: FlagKey, ctx: FlagContext): Promise<boolean> {
  const flags = await evaluate([key], ctx);
  return flags !== undefined && on(flags, key);
}

/** The variant of a multivariate flag, or undefined for a boolean flag or without definitions. */
export async function getVariant(key: FlagKey, ctx: FlagContext): Promise<string | undefined> {
  const flags = await evaluate([key], ctx);
  const value = flags?.getFlag(key, { sendFeatureFlagEvents: false });
  return typeof value === "string" ? value : undefined;
}
