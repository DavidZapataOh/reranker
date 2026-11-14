import type { AppEnv } from "@reranker/schema";

export type CatalogEntry = {
  /** `*` stands for any run of name characters, for families such as SPEND_CAP_DAILY_*_USD. */
  name: string;
  kind: "secret" | "config";
  /** Vercel environments that hold the variable. */
  vercel: readonly AppEnv[];
  /** Held as a GitHub repository secret (kind secret) or variable (kind config). */
  github: boolean;
  /** The plan that owns the value and its format. */
  owner: string;
  /** True once the owning plan ships it; only active entries can be reported as missing. */
  active: boolean;
};

const ALL: readonly AppEnv[] = ["production", "preview", "development"];
const PROD: readonly AppEnv[] = ["production"];
const PROD_PREV: readonly AppEnv[] = ["production", "preview"];
const PREVIEW: readonly AppEnv[] = ["preview"];
const NONE: readonly AppEnv[] = [];

type Row = [
  names: string,
  kind: CatalogEntry["kind"],
  vercel: readonly AppEnv[],
  github: boolean,
  owner: string,
  active?: true,
];

// Source of truth for every variable the product reads or stores. A plan that renames or adds
// one updates this table in the same change; the audit and the fragment test enforce it.
const rows: Row[] = [
  ["APP_ENV", "config", ALL, false, "08", true],
  ["NEXT_PUBLIC_POSTHOG_KEY", "config", ALL, false, "landing", true],
  ["NEXT_PUBLIC_POSTHOG_REGION", "config", ALL, false, "S03-04"],
  ["POSTHOG_PROJECT_TOKEN", "config", ALL, false, "S03-04"],
  ["POSTHOG_HOST", "config", ALL, false, "08"],
  ["NEXT_PUBLIC_GA_ID", "config", PROD, false, "landing", true],
  ["NEXT_PUBLIC_CLARITY_ID", "config", PROD, false, "landing", true],
  ["POSTHOG_FEATURE_FLAGS_KEY", "secret", ALL, false, "08"],
  ["POSTHOG_API_KEY", "secret", PROD, false, "08"],
  ["POSTHOG_PROJECT_ID", "config", PROD, false, "08"],
  ["POSTHOG_READONLY_API_KEY", "secret", NONE, true, "08"],
  ["POSTHOG_PERSONAL_API_KEY", "secret", NONE, true, "S03-04"],
  ["OPS_ALERT_EMAIL", "config", PROD_PREV, false, "08"],
  ["POSTHOG_QUERY_READ_KEY", "secret", PROD, false, "08"],
  ["LOG_LEVEL", "config", ALL, false, "08"],
  ["BETTERSTACK_HEARTBEAT_DAILY_URL", "secret", PROD, false, "08"],
  ["BETTERSTACK_HEARTBEAT_NIGHTLY_URL", "secret", NONE, true, "02 / 08"],
  ["GITHUB_BILLING_READ_TOKEN", "secret", PROD, false, "08"],
  ["DATABASE_URL", "secret", ALL, false, "03", true],
  ["DATABASE_URL_SYSTEM", "secret", ALL, false, "03", true],
  ["DATABASE_URL_MIGRATIONS", "secret", ALL, false, "03", true],
  ["DB_POOL_MAX", "config", ALL, false, "03"],
  ["DB_LOGIN_PASSWORDS", "secret", NONE, true, "03"],
  ["NEON_API_KEY", "secret", PROD, false, "03 / 08"],
  // GitHub holds the reranker-nonprod id; Vercel Production holds the reranker-prod id.
  ["NEON_PROJECT_ID", "config", PROD, true, "03 / 08", true],
  ["NEON_NONPROD_PROJECT_ID", "config", PROD, false, "03 / 08"],
  ["BETTER_AUTH_SECRET", "secret", ALL, false, "04"],
  ["BETTER_AUTH_SECRETS", "secret", ALL, false, "04"],
  ["BETTER_AUTH_URL", "config", ALL, false, "04"],
  ["GOOGLE_CLIENT_ID", "config", ALL, false, "04"],
  ["GOOGLE_CLIENT_SECRET", "secret", ALL, false, "04"],
  ["RESEND_API_KEY", "secret", ALL, false, "04 / S03-03"],
  ["RESEND_API_KEY_CI", "secret", NONE, true, "04 / S03-03"],
  ["RESEND_WEBHOOK_SECRET", "secret", ALL, false, "S03-03"],
  ["LEAD_LINK_SECRET", "secret", ALL, false, "S03-03"],
  ["LEAD_SUBJECT_SECRET", "secret", ALL, false, "S03-03"],
  ["EMAIL_FROM_REPORTS", "config", ALL, false, "S03-03"],
  ["EMAIL_REPLY_TO", "config", ALL, false, "S03-03"],
  ["TURNSTILE_SECRET_KEY", "secret", ALL, false, "04"],
  ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "config", ALL, false, "04"],
  ["CAPACITY_HMAC_KEY", "secret", ALL, false, "04"],
  ["FREE_REPORT_CHOICE_KEY", "secret", ALL, false, "S03-01"],
  ["QUALITY_CANARY_TOKEN", "secret", ALL, true, "S03-01"],
  ["FREE_REPORT_CAPTURE_CUTOFF_MS", "config", ALL, false, "S03-01"],
  ["FREE_REPORT_REUSE_HOURS", "config", ALL, false, "S03-01"],
  ["FREE_REPORT_IP_PER_HOUR", "config", ALL, false, "S03-01"],
  ["FREE_REPORT_IP_PER_DAY", "config", ALL, false, "S03-01"],
  ["FREE_REPORT_NET_PER_DAY", "config", ALL, false, "S03-01"],
  ["FREE_REPORT_HOSTING_PER_DAY", "config", ALL, false, "S03-01"],
  ["FREE_REPORT_IDENTITY_PER_DAY", "config", ALL, false, "S03-01"],
  ["FREE_REPORT_VERIFIED_IP_PER_DAY", "config", ALL, false, "S03-01"],
  ["FREE_REPORT_VELOCITY_*", "config", ALL, false, "S03-01"],
  ["FREE_REPORT_VERIFY_HOLD_MS", "config", ALL, false, "S03-01"],
  ["FREE_REPORT_DRAIN_AT", "config", ALL, false, "S03-01"],
  ["FREE_REPORT_TEST_DELAY_MS", "config", PREVIEW, false, "S03-01"],
  ["CRON_SECRET", "secret", PROD_PREV, false, "07"],
  ["SPEND_CAP_DAILY_*_USD", "config", ALL, false, "07"],
  ["QUOTA_RESEND_EMAILS_DAILY", "config", ALL, false, "07"],
  ["QUOTA_RESEND_EMAILS_SPLIT", "config", ALL, false, "07"],
  ["DATAFORSEO_MAX_IN_FLIGHT", "config", ALL, false, "07"],
  ["DATAFORSEO_RPM", "config", ALL, false, "07"],
  ["BRIGHTDATA_MAX_IN_FLIGHT", "config", ALL, false, "07"],
  ["OPENAI_RPM", "config", ALL, false, "07"],
  ["OPENAI_TPM", "config", ALL, false, "07"],
  ["OPENAI_MAX_IN_FLIGHT", "config", ALL, false, "07"],
  ["GEMINI_MAX_IN_FLIGHT", "config", ALL, false, "07"],
  ["GEMINI_RPM", "config", ALL, false, "07"],
  ["GEMINI_TPM", "config", ALL, false, "07"],
  ["GOOGLE_PLACES_MAX_IN_FLIGHT", "config", ALL, false, "07"],
  ["GOOGLE_PLACES_QPM", "config", ALL, false, "07"],
  ["JOBS_MAX_INLINE_WAIT_MS", "config", ALL, false, "07"],
  ["BREAKER_MIN_CALLS", "config", ALL, false, "07"],
  ["BREAKER_FAILURE_RATIO", "config", ALL, false, "07"],
  ["BREAKER_OPEN_MS", "config", ALL, false, "07"],
  // GitHub holds the sandbox values, used by the contract tests.
  ["DATAFORSEO_LOGIN", "secret", ALL, true, "S02-02"],
  ["DATAFORSEO_PASSWORD", "secret", ALL, true, "S02-02"],
  ["OPENAI_API_KEY", "secret", ALL, false, "S02-03 / S02-04"],
  ["OPENAI_API_KEY_CI", "secret", NONE, true, "S02-03 / S02-04"],
  ["OPENAI_CONTROL_MODEL", "config", ALL, false, "S02-03 / S02-04"],
  ["GEMINI_API_KEY", "secret", ALL, false, "S02-04 / S02-01"],
  ["BRIGHTDATA_API_KEY", "secret", PROD, false, "S02-08"],
  ["BRIGHTDATA_API_KEY_CI", "secret", NONE, true, "S02-08"],
  ["BRIGHTDATA_PERPLEXITY_DATASET_ID", "config", PROD, false, "S02-08"],
  ["ANTHROPIC_API_KEY_CI", "secret", NONE, true, "B0-01"],
  ["XAI_API_KEY_CI", "secret", NONE, true, "B0-01"],
  ["GOOGLE_PLACES_API_KEY", "secret", ALL, false, "S02-04"],
  ["GOOGLE_PLACES_API_KEY_CI", "secret", NONE, true, "S02-04"],
  ["R2_ACCOUNT_ID", "config", ALL, false, "S02-06"],
  ["R2_ACCESS_KEY_ID", "secret", ALL, false, "S02-06"],
  ["R2_SECRET_ACCESS_KEY", "secret", ALL, false, "S02-06"],
  ["R2_EVIDENCE_BUCKET", "config", ALL, false, "S02-06"],
  ["R2_LOG_BUCKET", "config", ALL, false, "S02-06"],
  ["CLOUDFLARE_CACHE_PURGE_TOKEN", "secret", ALL, false, "S02-06"],
  ["EVIDENCE_CAPTURE_SIGNING_KEY", "secret", ALL, false, "S02-06"],
  ["EVIDENCE_LOG_SIGNING_KEY", "secret", ALL, false, "S02-06"],
  ["EVIDENCE_*_KEY_ID", "config", ALL, false, "S02-06"],
  ["EVIDENCE_LOG_ORIGIN", "config", ALL, false, "S02-06"],
  ["EVIDENCE_*_BASE_URL", "config", ALL, false, "S02-06"],
  ["TURBO_TEAM", "config", NONE, true, "01", true],
  ["TURBO_REMOTE_CACHE_SIGNATURE_KEY", "secret", ALL, true, "01", true],
  ["ENABLE_EXPERIMENTAL_COREPACK", "config", ALL, false, "01", true],
  ["VERCEL_AUTOMATION_BYPASS_SECRET", "secret", NONE, true, "02", true],
  ["NEON_NONPROD_API_KEY", "secret", NONE, true, "02 / 03", true],
];

export const catalog: readonly CatalogEntry[] = rows.map(
  ([name, kind, vercel, github, owner, active]) => ({
    name,
    kind,
    vercel,
    github,
    owner,
    active: active === true,
  }),
);

function matches(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[A-Z0-9_]+");
  return new RegExp(`^${source}$`).test(name);
}

/** Whether the catalog declares the variable, directly or through a wildcard family. */
export function inCatalog(name: string, entries: readonly CatalogEntry[] = catalog): boolean {
  return entries.some((entry) => matches(entry.name, name));
}

/**
 * Compares the names a repository holds with the catalog entries it may hold: `unexpected` are
 * names the catalog does not allow, `missing` are active entries that are absent.
 */
export function auditSecrets(
  names: readonly string[],
  entries: readonly CatalogEntry[],
): { unexpected: string[]; missing: string[] } {
  const allowed = entries.filter((entry) => entry.github);
  const held = new Set(names);
  return {
    unexpected: names.filter((name) => !allowed.some((entry) => entry.name === name)),
    missing: allowed.filter((e) => e.active && !held.has(e.name)).map((e) => e.name),
  };
}
