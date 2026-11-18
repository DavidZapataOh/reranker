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

// Source of truth for every variable the product reads or stores. A plan that renames or adds
// one updates this table in the same change; the audit and the fragment test enforce it.
const rows: Row[] = [
  ["APP_ENV", "config", ALL, false, "08", true],
  ["NEXT_PUBLIC_POSTHOG_KEY", "config", ALL, false, "landing", true],
  ["NEXT_PUBLIC_POSTHOG_REGION", "config", ALL, false, "S03-04"],
  ["POSTHOG_PROJECT_TOKEN", "config", ALL, false, "S03-04", true],
  ["POSTHOG_HOST", "config", ALL, false, "08", true],
  ["NEXT_PUBLIC_GA_ID", "config", PROD, false, "landing", true],
  ["NEXT_PUBLIC_CLARITY_ID", "config", PROD, false, "landing", true],
  ["POSTHOG_FEATURE_FLAGS_KEY", "secret", ALL, false, "08", true],
  ["POSTHOG_API_KEY", "secret", PROD, false, "08"],
  ["POSTHOG_PROJECT_ID", "config", PROD, false, "08", true],
  // Inactive until the founder adds them to GitHub: personal API key with feature_flag:read, and
  // the CI copies of the flags key and project token that the nightly flags contract test reads.
  ["POSTHOG_READONLY_API_KEY", "secret", NONE, true, "08", true],
  ["POSTHOG_PROJECT_TOKEN_CI", "config", NONE, true, "08", true],
  ["POSTHOG_PERSONAL_API_KEY", "secret", NONE, true, "S03-04"],
  ["OPS_ALERT_EMAIL", "config", PROD_PREV, false, "08"],
  ["POSTHOG_QUERY_READ_KEY", "secret", PROD, false, "08"],
  // CI copies of the digest keys, for the nightly contract tests of the digest sources.
  ["POSTHOG_QUERY_READ_KEY_CI", "secret", NONE, true, "08", true],
  ["GH_BILLING_READ_TOKEN_CI", "secret", NONE, true, "08", true],
  ["LOG_LEVEL", "config", ALL, false, "08"],
  ["BETTERSTACK_HEARTBEAT_DAILY_URL", "secret", PROD, false, "08"],
  ["BETTERSTACK_HEARTBEAT_NIGHTLY_URL", "secret", NONE, true, "02 / 08"],
  ["GITHUB_BILLING_READ_TOKEN", "secret", PROD, false, "08"],
  ["POSTHOG_PLAN", "config", ALL, false, "launch"],
  ["NEON_MONTHLY_BUDGET_USD", "config", PROD, false, "launch"],
  ["WORKFLOWS_MONTHLY_BUDGET_USD", "config", PROD, false, "launch"],
  // Read-only keys the launch gate verifies the provider tiers with, in the daily run and in
  // `launch:check` / `flags:sync --enable` run with the production environment.
  ["BETTERSTACK_API_TOKEN", "secret", PROD, false, "launch"],
  ["POSTHOG_LAUNCH_READ_KEY", "secret", PROD, false, "launch"],
  ["GITHUB_REPO_READ_TOKEN", "secret", PROD, false, "launch"],
  ["VERCEL_BILLING_READ_TOKEN", "secret", PROD, false, "launch"],
  // Previews receive both URLs per deployment, for their own Neon branch, from the preview workflow.
  ["DATABASE_URL", "secret", PROD, false, "03", true],
  ["DATABASE_URL_SYSTEM", "secret", PROD, false, "03", true],
  // Only the production GitHub Environment holds it; no Vercel build or function ever does.
  ["DATABASE_URL_MIGRATIONS", "secret", NONE, false, "03", true],
  ["DB_POOL_MAX", "config", ALL, false, "03"],
  ["DB_LOGIN_PASSWORDS", "secret", NONE, true, "03"],
  ["NEON_API_KEY", "secret", PROD, false, "03 / 08"],
  // Organization key for the nightly db:usage contract test: the consumption endpoint is
  // organization-wide, so the project-scoped NEON_NONPROD_API_KEY cannot read it.
  ["NEON_API_KEY_CI", "secret", NONE, true, "03 / 08", true],
  // GitHub holds the reranker-nonprod id; Vercel Production holds the reranker-prod id.
  ["NEON_PROJECT_ID", "config", PROD, true, "03 / 08", true],
  ["NEON_NONPROD_PROJECT_ID", "config", PROD, false, "03 / 08"],
  ["BETTER_AUTH_SECRET", "secret", ALL, false, "04", true],
  ["BETTER_AUTH_SECRETS", "secret", ALL, false, "04"],
  // Preview derives its auth origin from the Vercel system variables below.
  ["BETTER_AUTH_URL", "config", PROD_DEV, false, "04", true],
  ["VERCEL_URL", "config", PROD_PREV, false, "04", true],
  ["VERCEL_BRANCH_URL", "config", PROD_PREV, false, "04", true],
  ["NEXT_PUBLIC_GOOGLE_CLIENT_ID", "config", ALL, false, "04"],
  ["GOOGLE_CLIENT_SECRET", "secret", ALL, false, "04"],
  ["RESEND_API_KEY", "secret", ALL, false, "04 / S03-03", true],
  ["RESEND_API_KEY_CI", "secret", NONE, true, "04 / S03-03", true],
  ["RESEND_WEBHOOK_SECRET", "secret", ALL, false, "S03-03"],
  ["LEAD_LINK_SECRET", "secret", ALL, false, "S03-03"],
  ["LEAD_SUBJECT_SECRET", "secret", ALL, false, "S03-03"],
  ["EMAIL_FROM_REPORTS", "config", ALL, false, "S03-03"],
  ["EMAIL_REPLY_TO", "config", ALL, false, "S03-03"],
  ["TURNSTILE_SECRET_KEY", "secret", ALL, false, "04"],
  ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "config", ALL, false, "04"],
  ["CAPACITY_HMAC_KEY", "secret", ALL, false, "04", true],
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
  ["CRON_SECRET", "secret", PROD_PREV, false, "07", true],
  // The load workflow calls the preview with the same value Vercel Preview holds.
  ["PREVIEW_CRON_SECRET", "secret", NONE, true, "07", true],
  ["SPEND_CAP_DAILY_*_USD", "config", ALL, false, "07", true],
  ["QUOTA_RESEND_EMAILS_HOURLY_FLOOR", "config", ALL, false, "07", true],
  ["QUOTA_RESEND_EMAILS_PEAK_MULTIPLIER", "config", ALL, false, "07", true],
  ["DATAFORSEO_MAX_IN_FLIGHT", "config", ALL, false, "07", true],
  ["DATAFORSEO_RPM", "config", ALL, false, "07", true],
  ["BRIGHTDATA_MAX_IN_FLIGHT", "config", ALL, false, "07", true],
  ["OPENAI_RPM", "config", ALL, false, "07", true],
  ["OPENAI_TPM", "config", ALL, false, "07", true],
  ["OPENAI_MAX_IN_FLIGHT", "config", ALL, false, "07", true],
  ["GEMINI_MAX_IN_FLIGHT", "config", ALL, false, "07", true],
  ["GEMINI_RPM", "config", ALL, false, "07", true],
  ["GEMINI_TPM", "config", ALL, false, "07", true],
  ["GOOGLE_PLACES_MAX_IN_FLIGHT", "config", ALL, false, "07", true],
  ["GOOGLE_PLACES_QPM", "config", ALL, false, "07", true],
  ["JOBS_MAX_INLINE_WAIT_MS", "config", ALL, false, "07", true],
  ["BREAKER_MIN_CALLS", "config", ALL, false, "07", true],
  ["BREAKER_FAILURE_RATIO", "config", ALL, false, "07", true],
  ["BREAKER_OPEN_MS", "config", ALL, false, "07", true],
  // GitHub holds the sandbox values, used by the contract tests.
  ["DATAFORSEO_LOGIN", "secret", ALL, true, "S02-02", true],
  ["DATAFORSEO_PASSWORD", "secret", ALL, true, "S02-02", true],
  ["OPENAI_API_KEY", "secret", ALL, false, "S02-03 / S02-04", true],
  ["OPENAI_API_KEY_CI", "secret", NONE, true, "S02-03 / S02-04"],
  ["OPENAI_CONTROL_MODEL", "config", ALL, false, "S02-03 / S02-04"],
  ["GEMINI_API_KEY", "secret", ALL, false, "S02-04 / S02-01", true],
  ["GEMINI_API_KEY_CI", "secret", NONE, true, "S02-04"],
  ["BRIGHTDATA_API_KEY", "secret", PROD, false, "S02-08"],
  ["BRIGHTDATA_API_KEY_CI", "secret", NONE, true, "S02-08"],
  ["BRIGHTDATA_PERPLEXITY_DATASET_ID", "config", PROD, false, "S02-08"],
  // Inactive until a Claude model wins an extraction role in the extractor benchmark.
  ["ANTHROPIC_API_KEY", "secret", ALL, false, "S02-04"],
  ["ANTHROPIC_API_KEY_CI", "secret", NONE, true, "B0-01"],
  ["XAI_API_KEY_CI", "secret", NONE, true, "B0-01"],
  ["GOOGLE_PLACES_API_KEY", "secret", ALL, false, "S02-04", true],
  ["ENTITY_NAME_HMAC_KEY", "secret", ALL, false, "S02-04", true],
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
  // The preview GitHub Environment holds these, so only the preview deploy job can read them.
  ["VERCEL_TOKEN", "secret", NONE, false, "02", true],
  ["VERCEL_ORG_ID", "config", NONE, false, "02", true],
  ["VERCEL_PROJECT_ID", "config", NONE, false, "02", true],
  ["NEON_NONPROD_API_KEY", "secret", NONE, true, "02 / 03", true],
  // Provisioning token scoped to R2, DNS, cache purge and zone read on reranker.co; it cannot
  // mint other tokens.
  ["CLOUDFLARE_API_TOKEN", "secret", NONE, true, "S02-06", true],
  ["CLOUDFLARE_ACCOUNT_ID", "config", NONE, true, "S02-06", true],
  ["CLOUDFLARE_ZONE_ID", "config", NONE, true, "S02-06", true],
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
