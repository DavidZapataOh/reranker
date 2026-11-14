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
});
