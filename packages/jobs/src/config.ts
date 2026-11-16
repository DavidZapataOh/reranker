import { appEnv, type EnvSource, EnvValidationError } from "@reranker/env";
import { costFromMajor, type ProviderCost } from "@reranker/schema";
import { jobsEnv } from "./env";
import type {
  JobPriority,
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
  quotas: Record<"resend.emails", { daily: number; split: Record<JobPriority, number> }>;
  limits: Record<PaidProvider, ProviderLimits>;
  maxInlineWaitMs: number;
  breaker: { minCalls: number; failureRatio: number; openMs: number };
}

// Daily USD. Providers other than the capture sandbox cost real money, so outside production
// they stay at zero and only the contract tests spend, under their own cap.
const PROVIDER_CAPS: Record<PaidProvider, string> = {
  dataforseo: "36",
  brightdata: "5",
  openai: "14",
  gemini: "11",
  google_places: "18",
  anthropic: "5",
  xai: "5",
};

const PURPOSE_CAPS: Record<SpendPurpose, string> = {
  "free-report": "50",
  "control-canary": "1",
  "quality-canary": "3",
  benchmark: "20",
  "contract-test": "0.5",
};

const POOL_CAPS: Record<SpendPool | SpendRegionPool, string> = {
  "free-report-anonymous": "30",
  "free-report-verified": "20",
  "free-report-elsewhere": "20",
};

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

  const caps = { global: usd("GLOBAL", "75") } as Record<CapScope, ProviderCost>;
  for (const [provider, fallback] of Object.entries(PROVIDER_CAPS)) {
    caps[`provider:${provider as PaidProvider}`] = usd(
      ENV_SUFFIX(provider),
      production ? fallback : "0",
    );
  }
  for (const [purpose, fallback] of Object.entries(PURPOSE_CAPS)) {
    caps[`purpose:${purpose as SpendPurpose}`] = usd(ENV_SUFFIX(purpose), fallback);
  }
  for (const [pool, fallback] of Object.entries(POOL_CAPS)) {
    caps[`pool:${pool as SpendPool | SpendRegionPool}`] = usd(ENV_SUFFIX(pool), fallback);
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

  const daily = num("QUOTA_RESEND_EMAILS_DAILY", 100);
  const parts = String(env.QUOTA_RESEND_EMAILS_SPLIT ?? "30/16/50/4")
    .split("/")
    .map(Number);
  if (parts.reduce((a, b) => a + b, 0) !== daily) {
    throw new Error("The resend.emails split must add up to the daily quota");
  }
  const [critical = 0, high = 0, normal = 0, low = 0] = parts;

  return {
    caps,
    quotas: { "resend.emails": { daily, split: { critical, high, normal, low } } },
    limits: {
      dataforseo: {
        maxInFlight: num("DATAFORSEO_MAX_IN_FLIGHT", 28),
        rpm: num("DATAFORSEO_RPM", 9000),
      },
      brightdata: { maxInFlight: num("BRIGHTDATA_MAX_IN_FLIGHT", 100) },
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
