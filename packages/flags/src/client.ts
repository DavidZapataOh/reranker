import { createHash } from "node:crypto";
import { defineEnv } from "@reranker/env";
import { sendOpsAlert } from "@reranker/telemetry";
import {
  type FeatureFlagEvaluations,
  type FlagDefinitionCacheData,
  type FlagDefinitionCacheProvider,
  PostHog,
} from "posthog-node";
import { flagsEnv } from "./env";

const ALERT_AFTER_MS = 5 * 60_000;
const ALERT_EVERY_MS = 60 * 60_000;
const COLD_START_WAIT_MS = 3_000;
const MAX_REMEMBERED = 4_096;

/**
 * Records a sha256 of every definitions payload PostHog sends. The SDK does not expose the ETag it
 * polls with, and a snapshot must name the exact definitions it was evaluated against.
 */
class HashingMemoryCache implements FlagDefinitionCacheProvider {
  etag: string | null = null;
  /** Evaluations of the current definitions, dropped as soon as different ones arrive. */
  readonly results = new Map<string, FeatureFlagEvaluations>();

  // With a secret key and every fetch allowed, the SDK keeps the definitions itself and never
  // reads them back from here.
  getFlagDefinitions(): undefined {
    return undefined;
  }

  shouldFetchFlagDefinitions(): boolean {
    return true;
  }

  onFlagDefinitionsReceived(data: FlagDefinitionCacheData): void {
    const etag = createHash("sha256").update(JSON.stringify(data.flags)).digest("hex");
    if (etag !== this.etag) this.results.clear();
    this.etag = etag;
  }

  shutdown(): void {}
}

type State = {
  client: PostHog;
  definitions: HashingMemoryCache;
  warmup?: Promise<boolean>;
  notReadySince?: number;
  lastAlertAt?: number;
};

// Next bundles route handlers separately, so the instance state lives on globalThis. Fluid compute
// reuses it across invocations, which keeps the polled definitions warm.
const STATE = Symbol.for("reranker.flags.posthog");
type Holder = typeof globalThis & { [STATE]?: State };

function create(): State {
  const env = defineEnv([flagsEnv]);
  const definitions = new HashingMemoryCache();
  const token = env.POSTHOG_PROJECT_TOKEN;
  const secretKey = env.POSTHOG_FEATURE_FLAGS_KEY;
  // Separate from the telemetry client: every PostHog client with a secret key polls definitions,
  // and each poll is billed, so only instances that evaluate flags should hold one.
  const client = new PostHog(token ?? "phc_unset", {
    ...(env.POSTHOG_HOST ? { host: env.POSTHOG_HOST } : {}),
    ...(secretKey ? { secretKey } : {}),
    featureFlagsPollingInterval: 30_000,
    disableGeoip: true,
    flagDefinitionCacheProvider: definitions,
    // Without a token or key nothing can load; the client stays inert and every flag reads off.
    disabled: token === undefined || secretKey === undefined,
  });
  return { client, definitions };
}

function state(): State {
  const holder = globalThis as Holder;
  holder[STATE] ??= create();
  return holder[STATE];
}

/** The PostHog client that evaluates flags locally. Internal: callers use the evaluation API. */
export function getFlagsClient(): PostHog {
  return state().client;
}

/** sha256 of the flag definitions in memory, or null before the first load. */
export function definitionsEtag(): string | null {
  return state().definitions.etag;
}

/**
 * Local evaluation hashes every rollout with WebCrypto on the libuv pool, about 0.3 ms per call and
 * more under load. The result depends only on the definitions and on the subject and properties in
 * `id`, so it is reused until PostHog sends different definitions.
 */
export async function remembered(
  id: string,
  evaluate: () => Promise<FeatureFlagEvaluations>,
): Promise<FeatureFlagEvaluations> {
  const { definitions } = state();
  const hit = definitions.results.get(id);
  if (hit) return hit;
  const etag = definitions.etag;
  const result = await evaluate();
  // Definitions that changed mid-evaluation make this result stale for the new version.
  if (definitions.etag === etag) {
    // Maps iterate in insertion order, so the first key is the oldest entry.
    if (definitions.results.size >= MAX_REMEMBERED) {
      definitions.results.delete(definitions.results.keys().next().value ?? id);
    }
    definitions.results.set(id, result);
  }
  return result;
}

/** Waits, once per instance, for the first definitions so a cold start does not fail closed. */
export async function warmUp(): Promise<void> {
  const s = state();
  s.warmup ??= s.client.waitForLocalEvaluationReady(COLD_START_WAIT_MS);
  await s.warmup;
}

/**
 * Whether local evaluation can run. Definitions missing for over five minutes raise
 * `flags-not-ready` at most once an hour; `sendOpsAlert` dedupes only the email, not the event.
 */
export function definitionsReady(): boolean {
  const s = state();
  if (s.client.isLocalEvaluationReady()) {
    delete s.notReadySince;
    return true;
  }
  const now = Date.now();
  s.notReadySince ??= now;
  const due = s.lastAlertAt === undefined || now - s.lastAlertAt >= ALERT_EVERY_MS;
  if (now - s.notReadySince > ALERT_AFTER_MS && due) {
    s.lastAlertAt = now;
    void sendOpsAlert("flags-not-ready", { since: new Date(s.notReadySince).toISOString() });
  }
  return false;
}

/** Stops the poller and drops the instance state so a test can start a new instance. */
export async function resetFlagsClient(): Promise<void> {
  const holder = globalThis as Holder;
  const current = holder[STATE];
  delete holder[STATE];
  await current?.client.shutdown(1_000);
}
