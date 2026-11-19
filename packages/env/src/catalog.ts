import type { AppEnv } from "@reranker/schema";

export type CatalogEntry = {
  /** `*` stands for any run of name characters, for families such as SPEND_CAP_DAILY_*_USD. */
  name: string;
  kind: "secret" | "config";
  /** Vercel environments that hold the variable. */
  vercel: readonly AppEnv[];
  /** Held as a GitHub repository secret (kind secret) or variable (kind config). */
  github: boolean;
  /** The workspace package or area that reads the value and owns its format. */
  owner: string;
  /** True once the code that reads it ships; only active entries can be reported as missing. */
  active: boolean;
};

const ALL: readonly AppEnv[] = ["production", "preview", "development"];
const PROD: readonly AppEnv[] = ["production"];
const PROD_PREV: readonly AppEnv[] = ["production", "preview"];
const PROD_DEV: readonly AppEnv[] = ["production", "development"];
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

// Source of truth for every variable the product reads or stores. A change that renames or
// adds one updates this table in the same commit; the audit and the fragment test enforce it.
const rows: Row[] = [
  ["APP_ENV", "config", ALL, false, "env", true],
  ["NEXT_PUBLIC_POSTHOG_KEY", "config", ALL, false, "analytics", true],
  ["NEXT_PUBLIC_POSTHOG_REGION", "config", ALL, false, "analytics"],
  ["POSTHOG_PROJECT_TOKEN", "config", ALL, false, "analytics", true],
  ["POSTHOG_HOST", "config", ALL, false, "analytics", true],
  ["NEXT_PUBLIC_GA_ID", "config", PROD, false, "analytics", true],
  ["NEXT_PUBLIC_CLARITY_ID", "config", PROD, false, "analytics", true],
  ["POSTHOG_FEATURE_FLAGS_KEY", "secret", ALL, false, "flags", true],
  ["POSTHOG_API_KEY", "secret", PROD, false, "telemetry"],
  ["POSTHOG_PROJECT_ID", "config", PROD, false, "telemetry", true],
  // Inactive until the founder adds them to GitHub: personal API key with feature_flag:read, and
  // the CI copies of the flags key and project token that the nightly flags contract test reads.
  ["POSTHOG_READONLY_API_KEY", "secret", NONE, true, "flags", true],
  ["POSTHOG_PROJECT_TOKEN_CI", "config", NONE, true, "flags", true],
  ["POSTHOG_PERSONAL_API_KEY", "secret", NONE, true, "flags"],
  ["OPS_ALERT_EMAIL", "config", PROD_PREV, false, "telemetry"],
  ["POSTHOG_QUERY_READ_KEY", "secret", PROD, false, "telemetry"],
  // CI copies of the digest keys, for the nightly contract tests of the digest sources.
  ["POSTHOG_QUERY_READ_KEY_CI", "secret", NONE, true, "telemetry", true],
  ["GH_BILLING_READ_TOKEN_CI", "secret", NONE, true, "telemetry", true],
  ["LOG_LEVEL", "config", ALL, false, "telemetry"],
  ["BETTERSTACK_HEARTBEAT_DAILY_URL", "secret", PROD, false, "telemetry"],
  ["BETTERSTACK_HEARTBEAT_NIGHTLY_URL", "secret", NONE, true, "telemetry"],
  ["GITHUB_BILLING_READ_TOKEN", "secret", PROD, false, "telemetry"],
  ["POSTHOG_PLAN", "config", ALL, false, "telemetry"],
  ["NEON_MONTHLY_BUDGET_USD", "config", PROD, false, "telemetry"],
  ["WORKFLOWS_MONTHLY_BUDGET_USD", "config", PROD, false, "jobs"],
  // Read-only keys the launch gate verifies the provider tiers with, in the daily run and in
  // `launch:check` / `flags:sync --enable` run with the production environment.
  ["BETTERSTACK_API_TOKEN", "secret", PROD, false, "telemetry"],
  ["POSTHOG_LAUNCH_READ_KEY", "secret", PROD, false, "telemetry"],
  ["GITHUB_REPO_READ_TOKEN", "secret", PROD, false, "telemetry"],
  ["VERCEL_BILLING_READ_TOKEN", "secret", PROD, false, "telemetry"],
  // Previews receive both URLs per deployment, for their own Neon branch, from the preview workflow.
  ["DATABASE_URL", "secret", PROD, false, "db", true],
  ["DATABASE_URL_SYSTEM", "secret", PROD, false, "db", true],
  // Only the production GitHub Environment holds it; no Vercel build or function ever does.
  ["DATABASE_URL_MIGRATIONS", "secret", NONE, false, "db", true],
  ["DB_POOL_MAX", "config", ALL, false, "db"],
  ["DB_LOGIN_PASSWORDS", "secret", NONE, true, "db"],
  ["NEON_API_KEY", "secret", PROD, false, "db"],
  // Organization key for the nightly db:usage contract test: the consumption endpoint is
  // organization-wide, so the project-scoped NEON_NONPROD_API_KEY cannot read it.
  ["NEON_API_KEY_CI", "secret", NONE, true, "db", true],
  // GitHub holds the reranker-nonprod id; Vercel Production holds the reranker-prod id.
  ["NEON_PROJECT_ID", "config", PROD, true, "db", true],
  ["NEON_NONPROD_PROJECT_ID", "config", PROD, false, "db"],
  ["BETTER_AUTH_SECRET", "secret", ALL, false, "auth", true],
  ["BETTER_AUTH_SECRETS", "secret", ALL, false, "auth"],
  // Preview derives its auth origin from the Vercel system variables below.
  ["BETTER_AUTH_URL", "config", PROD_DEV, false, "auth", true],
  ["VERCEL_URL", "config", PROD_PREV, false, "auth", true],
  ["VERCEL_BRANCH_URL", "config", PROD_PREV, false, "auth", true],
  ["NEXT_PUBLIC_GOOGLE_CLIENT_ID", "config", ALL, false, "auth"],
  ["GOOGLE_CLIENT_SECRET", "secret", ALL, false, "auth"],
  ["RESEND_API_KEY", "secret", ALL, false, "auth", true],
  ["RESEND_API_KEY_CI", "secret", NONE, true, "auth", true],
  ["RESEND_WEBHOOK_SECRET", "secret", ALL, false, "email"],
  ["LEAD_LINK_SECRET", "secret", ALL, false, "email"],
  ["LEAD_SUBJECT_SECRET", "secret", ALL, false, "email"],
  ["EMAIL_FROM_REPORTS", "config", ALL, false, "email"],
  ["EMAIL_REPLY_TO", "config", ALL, false, "email"],
  ["TURNSTILE_SECRET_KEY", "secret", ALL, false, "auth"],
  ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "config", ALL, false, "auth"],
  ["CAPACITY_HMAC_KEY", "secret", ALL, false, "auth", true],
  ["FREE_REPORT_CHOICE_KEY", "secret", ALL, false, "reports"],
  ["QUALITY_CANARY_TOKEN", "secret", ALL, true, "reports"],
  ["FREE_REPORT_CAPTURE_CUTOFF_MS", "config", ALL, false, "reports"],
  ["FREE_REPORT_REUSE_HOURS", "config", ALL, false, "reports"],
  ["FREE_REPORT_IP_PER_HOUR", "config", ALL, false, "reports"],
  ["FREE_REPORT_IP_PER_DAY", "config", ALL, false, "reports"],
  ["FREE_REPORT_NET_PER_DAY", "config", ALL, false, "reports"],
  ["FREE_REPORT_HOSTING_PER_DAY", "config", ALL, false, "reports"],
  ["FREE_REPORT_IDENTITY_PER_DAY", "config", ALL, false, "reports"],
  ["FREE_REPORT_VERIFIED_IP_PER_DAY", "config", ALL, false, "reports"],
  ["FREE_REPORT_VELOCITY_*", "config", ALL, false, "reports"],
  ["FREE_REPORT_VERIFY_HOLD_MS", "config", ALL, false, "reports"],
  ["FREE_REPORT_DRAIN_AT", "config", ALL, false, "reports"],
  ["FREE_REPORT_TEST_DELAY_MS", "config", PREVIEW, false, "reports"],
  ["CRON_SECRET", "secret", PROD_PREV, false, "jobs", true],
  // The load workflow calls the preview with the same value Vercel Preview holds.
  ["PREVIEW_CRON_SECRET", "secret", NONE, true, "jobs", true],
  ["SPEND_CAP_DAILY_*_USD", "config", ALL, false, "jobs", true],
  ["QUOTA_RESEND_EMAILS_HOURLY_FLOOR", "config", ALL, false, "jobs", true],
  ["QUOTA_RESEND_EMAILS_PEAK_MULTIPLIER", "config", ALL, false, "jobs", true],
  ["DATAFORSEO_MAX_IN_FLIGHT", "config", ALL, false, "jobs", true],
  ["DATAFORSEO_RPM", "config", ALL, false, "jobs", true],
  ["BRIGHTDATA_MAX_IN_FLIGHT", "config", ALL, false, "jobs", true],
  ["OPENAI_RPM", "config", ALL, false, "jobs", true],
  ["OPENAI_TPM", "config", ALL, false, "jobs", true],
  ["OPENAI_MAX_IN_FLIGHT", "config", ALL, false, "jobs", true],
  ["GEMINI_MAX_IN_FLIGHT", "config", ALL, false, "jobs", true],
  ["GEMINI_RPM", "config", ALL, false, "jobs", true],
  ["GEMINI_TPM", "config", ALL, false, "jobs", true],
  ["GOOGLE_PLACES_MAX_IN_FLIGHT", "config", ALL, false, "jobs", true],
  ["GOOGLE_PLACES_QPM", "config", ALL, false, "jobs", true],
  ["JOBS_MAX_INLINE_WAIT_MS", "config", ALL, false, "jobs", true],
  ["BREAKER_MIN_CALLS", "config", ALL, false, "jobs", true],
  ["BREAKER_FAILURE_RATIO", "config", ALL, false, "jobs", true],
  ["BREAKER_OPEN_MS", "config", ALL, false, "jobs", true],
  // GitHub holds the sandbox values, used by the contract tests.
  ["DATAFORSEO_LOGIN", "secret", ALL, true, "capture", true],
  ["DATAFORSEO_PASSWORD", "secret", ALL, true, "capture", true],
  ["OPENAI_API_KEY", "secret", ALL, false, "extraction", true],
  ["OPENAI_API_KEY_CI", "secret", NONE, true, "extraction", true],
  ["OPENAI_CONTROL_MODEL", "config", ALL, false, "capture"],
  ["OPENAI_CONTROL_API_KEY", "secret", PROD, false, "capture", true],
  ["GEMINI_API_KEY", "secret", ALL, false, "extraction", true],
  ["GEMINI_API_KEY_CI", "secret", NONE, true, "extraction", true],
  ["BRIGHTDATA_API_KEY", "secret", PROD, false, "capture", true],
  ["BRIGHTDATA_API_KEY_CI", "secret", NONE, true, "capture", true],
  // Finance permission: the only role that reads the account's free tier and balance.
  ["BRIGHTDATA_BILLING_API_KEY", "secret", PROD, false, "capture", true],
  ["BRIGHTDATA_BILLING_API_KEY_CI", "secret", NONE, true, "capture", true],
  // Unset unless Bright Data replaces a scraper: the defaults are its published dataset ids.
  ["BRIGHTDATA_PERPLEXITY_DATASET_ID", "config", PROD, false, "capture"],
  ["BRIGHTDATA_CHATGPT_DATASET_ID", "config", PROD, false, "capture"],
  // Inactive until a Claude model wins an extraction role in the extractor benchmark.
  ["ANTHROPIC_API_KEY", "secret", ALL, false, "extraction"],
  ["ANTHROPIC_API_KEY_CI", "secret", NONE, true, "benchmark"],
  ["XAI_API_KEY_CI", "secret", NONE, true, "benchmark"],
  ["GOOGLE_PLACES_API_KEY", "secret", ALL, false, "extraction", true],
  ["ENTITY_NAME_HMAC_KEY", "secret", ALL, false, "extraction", true],
  ["GOOGLE_PLACES_API_KEY_CI", "secret", NONE, true, "extraction", true],
  ["R2_ACCOUNT_ID", "config", ALL, false, "evidence"],
  ["R2_ACCESS_KEY_ID", "secret", ALL, false, "evidence"],
  ["R2_SECRET_ACCESS_KEY", "secret", ALL, false, "evidence"],
  ["R2_EVIDENCE_BUCKET", "config", ALL, false, "evidence"],
  ["R2_LOG_BUCKET", "config", ALL, false, "evidence"],
  ["R2_INTERNAL_BUCKET", "config", ALL, false, "evidence"],
  // Bucket-scoped R2 S3 key of the preview buckets, for the nightly storage contract test.
  ["R2_ACCESS_KEY_ID_CI", "secret", NONE, true, "evidence", true],
  ["R2_SECRET_ACCESS_KEY_CI", "secret", NONE, true, "evidence", true],
  ["CLOUDFLARE_CACHE_PURGE_TOKEN", "secret", ALL, false, "evidence"],
  // Signing keys live in AWS KMS: the deployment holds ARNs and assumes the role through Vercel
  // OIDC, so no variable ever carries private key material.
  ["AWS_REGION", "config", ALL, false, "evidence"],
  ["AWS_ROLE_ARN", "config", ALL, false, "evidence"],
  ["EVIDENCE_*_KMS_KEY_ARN", "config", ALL, false, "evidence"],
  ["EVIDENCE_*_KEY_ID", "config", ALL, false, "evidence"],
  // qtsa.eu stamps are bought for production only.
  ["QTSA_TSA_URL", "secret", PROD, false, "evidence"],
  ["QTSA_PACKAGE_*", "config", PROD, false, "evidence"],
  ["EVIDENCE_LOG_ORIGIN", "config", ALL, false, "evidence"],
  ["EVIDENCE_*_BASE_URL", "config", ALL, false, "evidence"],
  // A capture sealed by a long-lived preview (its origin, log origin and id) that the nightly
  // verifier contract test checks end to end.
  ["VERIFY_CONTRACT_*", "config", NONE, true, "verify"],
  ["TURBO_TEAM", "config", NONE, true, "ci", true],
  ["TURBO_REMOTE_CACHE_SIGNATURE_KEY", "secret", ALL, true, "ci", true],
  ["ENABLE_EXPERIMENTAL_COREPACK", "config", ALL, false, "ci", true],
  ["VERCEL_AUTOMATION_BYPASS_SECRET", "secret", NONE, true, "ci", true],
  // The preview GitHub Environment holds these, so only the preview deploy job can read them.
  ["VERCEL_TOKEN", "secret", NONE, false, "ci", true],
  ["VERCEL_ORG_ID", "config", NONE, false, "ci", true],
  ["VERCEL_PROJECT_ID", "config", NONE, false, "ci", true],
  ["NEON_NONPROD_API_KEY", "secret", NONE, true, "ci", true],
  // Provisioning token scoped to R2, DNS, cache purge and zone read on reranker.co; it cannot
  // mint other tokens.
  ["CLOUDFLARE_API_TOKEN", "secret", NONE, true, "evidence", true],
  ["CLOUDFLARE_ACCOUNT_ID", "config", NONE, true, "evidence", true],
  // Vercel also holds it for the cache purge after an artifact removal.
  ["CLOUDFLARE_ZONE_ID", "config", ALL, true, "evidence", true],
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
