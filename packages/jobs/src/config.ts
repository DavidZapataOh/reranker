import { appEnv, type EnvSource, EnvValidationError } from "@reranker/env";
import { costFromMajor, type ProviderCost } from "@reranker/schema";
import { jobsEnv } from "./env";
import type {
  PaidProvider,
  ProviderLimits,
  SpendPool,
  SpendPurpose,
  SpendRegionPool,
} from "./providers";

export { jobsEnv } from "./env";

type CapScope =
  | "global"
  | `provider:${PaidProvider}`
  | `purpose:${SpendPurpose}`
  | `pool:${SpendPool | SpendRegionPool}`;

export interface JobsConfig {
  caps: Record<CapScope, ProviderCost>;
  /** Hourly flood brakes: an hour allows `max(hourlyFloor, peakMultiplier × last week's peak hour)`. */
  quotas: Record<"resend.emails", { hourlyFloor: number; peakMultiplier: number }>;
  limits: Record<PaidProvider, ProviderLimits>;
  maxInlineWaitMs: number;
  /** Monthly provider budgets the daily run measures spend against. */
  budgets: { workflowsMonthlyUsd: number };
  breaker: { minCalls: number; failureRatio: number; openMs: number };
}

// Daily USD, sized by demand: the free report pools add up to its cap.
const PURPOSE_CAPS: Record<SpendPurpose, string> = {
  "free-report": "200",
  "control-canary": "70",
  "quality-canary": "6",
  benchmark: "40",
  // A night of contract tests reserves about 0.17 (five Text Search Pro calls and three short LLM
  // extractions), 0.35 when every one is retried. Weekly measurements raise it for their own run.
  "contract-test": "0.5",
};

const POOL_CAPS: Record<SpendPool | SpendRegionPool, string> = {
  "free-report-anonymous": "120",
  "free-report-verified": "80",
  "free-report-elsewhere": "80",
};

const GLOBAL_CAP = "320";

const EVERY_PURPOSE = Object.keys(PURPOSE_CAPS) as SpendPurpose[];
const BENCHMARK_ONLY: readonly SpendPurpose[] = ["benchmark", "contract-test"];

// The purposes that can spend on each provider. Anthropic and xAI only annotate benchmark labels.
const PROVIDER_PURPOSES: Record<PaidProvider, readonly SpendPurpose[]> = {
  dataforseo: EVERY_PURPOSE,
  brightdata: EVERY_PURPOSE,
  openai: EVERY_PURPOSE,
  gemini: EVERY_PURPOSE,
  google_places: EVERY_PURPOSE,
  anthropic: BENCHMARK_ONLY,
  xai: BENCHMARK_ONLY,
};

/**
 * The lowest daily cap, in micros, each provider can have without binding before the caps of the
 * purposes that spend on it: their sum plus a fifth of headroom.
 */
export function providerCapFloor(config: Pick<JobsConfig, "caps">): Record<PaidProvider, number> {
  return Object.fromEntries(
    Object.entries(PROVIDER_PURPOSES).map(([provider, purposes]) => {
      const sum = purposes.reduce((t, p) => t + config.caps[`purpose:${p}`].amount_micros, 0);
      return [provider, Math.ceil((sum * 6) / 5)];
    }),
  ) as Record<PaidProvider, number>;
}

const ENV_SUFFIX = (name: string) => name.toUpperCase().replaceAll("-", "_");

function parse(source: EnvSource) {
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== "") present[key] = value;
  }
  const parsed = jobsEnv.safeParse(present);
  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map((i) => ({ name: String(i.path[0]), problem: "invalid" })),
    );
  }
  return parsed.data;
}

function build(source: EnvSource): JobsConfig {
  const env: Record<string, string | number | undefined> = parse(source);
  const production = appEnv(source) === "production";
  const usd = (name: string, fallback: string) =>
    costFromMajor(String(env[`SPEND_CAP_DAILY_${name}_USD`] ?? fallback), "USD");
  const num = (name: string, fallback: number): number => Number(env[name] ?? fallback);
  // exactOptionalPropertyTypes forbids an explicit undefined, so absent limits are left out.
  const rate = (name: string): { rpm?: number } =>
    env[name] === undefined ? {} : { rpm: Number(env[name]) };
  const tokens = (name: string): { tpm?: number } =>
    env[name] === undefined ? {} : { tpm: Number(env[name]) };

  const caps = { global: usd("GLOBAL", GLOBAL_CAP) } as Record<CapScope, ProviderCost>;
  for (const [purpose, fallback] of Object.entries(PURPOSE_CAPS)) {
    caps[`purpose:${purpose as SpendPurpose}`] = usd(ENV_SUFFIX(purpose), fallback);
  }
  for (const [pool, fallback] of Object.entries(POOL_CAPS)) {
    caps[`pool:${pool as SpendPool | SpendRegionPool}`] = usd(ENV_SUFFIX(pool), fallback);
  }
  // Provider caps follow their purposes, so raising a purpose cap never needs a provider change.
  // Outside production they stay at zero and only the contract tests spend, under their own cap.
  for (const [provider, floor] of Object.entries(providerCapFloor({ caps }))) {
    caps[`provider:${provider as PaidProvider}`] = usd(
      ENV_SUFFIX(provider),
      production ? (floor / 1_000_000).toFixed(6) : "0",
    );
  }

  const freeReport = caps["purpose:free-report"].amount_micros;
  const pools =
    caps["pool:free-report-anonymous"].amount_micros +
    caps["pool:free-report-verified"].amount_micros;
  if (pools !== freeReport) {
    throw new Error("The free report pool caps (anonymous + verified) must add up to its cap");
  }
  if (caps["pool:free-report-elsewhere"].amount_micros > freeReport) {
    throw new Error("The free report elsewhere pool cap cannot exceed the free report cap");
  }

  return {
    caps,
    quotas: {
      "resend.emails": {
        hourlyFloor: num("QUOTA_RESEND_EMAILS_HOURLY_FLOOR", 500),
        peakMultiplier: num("QUOTA_RESEND_EMAILS_PEAK_MULTIPLIER", 10),
      },
    },
    limits: {
      dataforseo: {
        maxInFlight: num("DATAFORSEO_MAX_IN_FLIGHT", 28),
        rpm: num("DATAFORSEO_RPM", 9000),
      },
      brightdata: { maxInFlight: num("BRIGHTDATA_MAX_IN_FLIGHT", 200) },
      openai: {
        maxInFlight: num("OPENAI_MAX_IN_FLIGHT", 10),
        ...rate("OPENAI_RPM"),
        ...tokens("OPENAI_TPM"),
      },
      gemini: {
        maxInFlight: num("GEMINI_MAX_IN_FLIGHT", 10),
        ...rate("GEMINI_RPM"),
        ...tokens("GEMINI_TPM"),
      },
      google_places: {
        maxInFlight: num("GOOGLE_PLACES_MAX_IN_FLIGHT", 10),
        ...rate("GOOGLE_PLACES_QPM"),
      },
      anthropic: { maxInFlight: 5 },
      xai: { maxInFlight: 5 },
    },
    maxInlineWaitMs: num("JOBS_MAX_INLINE_WAIT_MS", 5000),
    budgets: { workflowsMonthlyUsd: num("WORKFLOWS_MONTHLY_BUDGET_USD", 10) },
    breaker: {
      minCalls: num("BREAKER_MIN_CALLS", 20),
      failureRatio: num("BREAKER_FAILURE_RATIO", 0.5),
      openMs: num("BREAKER_OPEN_MS", 30_000),
    },
  };
}

let cached: JobsConfig | undefined;

/** Reads the process environment once; pass a source to evaluate another one without caching. */
export function loadJobsConfig(source?: EnvSource): JobsConfig {
  if (source) return build(source);
  cached ??= build(process.env);
  return cached;
}
