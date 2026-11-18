import { config, requiredIn, secret } from "@reranker/env";
import { z } from "@reranker/schema";

// The variables below `POSTHOG_HOST` stay optional until the task that consumes each one makes
// it requiredIn(["production"]); requiring them earlier would fail every deploy for nothing.
export const telemetryEnv = z.object({
  POSTHOG_PROJECT_TOKEN: requiredIn(
    ["preview", "production"],
    config(z.string().startsWith("phc_"), "PostHog project token for server events and flags"),
  ),
  POSTHOG_HOST: requiredIn(
    ["preview", "production"],
    config(z.url(), "PostHog ingestion host, e.g. https://us.i.posthog.com"),
  ),
  POSTHOG_PROJECT_ID: config(z.string().min(1).optional(), "PostHog project id for API queries"),
  OPS_ALERT_EMAIL: config(z.email().optional(), "Inbox that receives operational alerts"),
  LOG_LEVEL: config(
    z.enum(["debug", "info", "warn", "error"]).default("info"),
    "Minimum level written to the logs",
  ),
  POSTHOG_API_KEY: secret(
    z.string().min(1).optional(),
    "PostHog personal API key for releases and source maps",
  ),
  BETTERSTACK_HEARTBEAT_DAILY_URL: secret(
    z.url().optional(),
    "Better Stack heartbeat URL pinged by the daily job",
  ),
  GITHUB_BILLING_READ_TOKEN: secret(
    z.string().min(1).optional(),
    "GitHub token that reads Actions billing for the daily digest",
  ),
  POSTHOG_QUERY_READ_KEY: secret(
    z.string().min(1).optional(),
    "PostHog key with query read scope for the daily digest",
  ),
  // Flips the Free allowances and the cap on insight alerts once a card is on file.
  POSTHOG_PLAN: config(
    z.enum(["free", "pay-as-you-go"]).default("free"),
    "PostHog organization plan: free or pay-as-you-go",
  ),
});

const usd = (description: string) =>
  config(z.coerce.number().nonnegative().optional(), description);

// Read-only credentials that verify the provider tiers before a gated flag goes on.
export const launchEnv = z.object({
  BETTERSTACK_API_TOKEN: secret(
    z.string().min(1).optional(),
    "Better Stack API token that reads monitors and incoming webhooks",
  ),
  POSTHOG_LAUNCH_READ_KEY: secret(
    z.string().min(1).optional(),
    "PostHog personal API key with billing:read, project:read, user:read and feature_flag:read",
  ),
  GITHUB_REPO_READ_TOKEN: secret(
    z.string().min(1).optional(),
    "GitHub token that reads the repository's visibility and owner",
  ),
  VERCEL_BILLING_READ_TOKEN: secret(
    z.string().min(1).optional(),
    "Vercel token scoped to the team that reads its plan and block status",
  ),
});

// Credentials the daily digest reads usage with. Each one is optional: a source without its
// credential shows "sin dato" in the digest instead of failing the run.
export const digestEnv = z.object({
  DATAFORSEO_LOGIN: secret(z.string().min(1).optional(), "DataForSEO API login"),
  DATAFORSEO_PASSWORD: secret(z.string().min(1).optional(), "DataForSEO API password"),
  NEON_API_KEY: secret(
    z.string().min(1).optional(),
    "Neon API key that reads usage of both projects",
  ),
  NEON_PROJECT_ID: config(z.string().min(1).optional(), "Neon project id of reranker-prod"),
  NEON_NONPROD_PROJECT_ID: config(
    z.string().min(1).optional(),
    "Neon project id of reranker-nonprod",
  ),
  NEON_MONTHLY_BUDGET_USD: usd("Monthly Neon budget for both projects, in USD"),
});
