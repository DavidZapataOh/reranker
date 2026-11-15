import { secret } from "@reranker/env";
import { z } from "@reranker/schema";
import { telemetryEnv } from "@reranker/telemetry/env";

// The key stays optional until it exists in Vercel; without it the flags never load and every
// kill switch fails closed.
export const flagsEnv = z.object({
  POSTHOG_FEATURE_FLAGS_KEY: secret(
    z.string().startsWith("phs_").optional(),
    "PostHog project secret API key with feature_flag:read, for local flag evaluation",
  ),
  POSTHOG_PROJECT_TOKEN: telemetryEnv.shape.POSTHOG_PROJECT_TOKEN,
  POSTHOG_HOST: telemetryEnv.shape.POSTHOG_HOST,
});
