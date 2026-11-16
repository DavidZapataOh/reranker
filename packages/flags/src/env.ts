import { requiredIn, secret } from "@reranker/env";
import { z } from "@reranker/schema";
import { telemetryEnv } from "@reranker/telemetry/env";

// Required in production so a missing key fails the deploy instead of silently closing every kill
// switch; previews and local runs have no key and fail closed.
export const flagsEnv = z.object({
  POSTHOG_FEATURE_FLAGS_KEY: requiredIn(
    ["production"],
    secret(
      // Project secret keys (phs_) in production; CI reads with its read-only personal key (phx_).
      z.string().regex(/^ph[sx]_/, "must be a PostHog secret or personal API key"),
      "PostHog project secret API key with feature_flag:read, for local flag evaluation",
    ),
  ),
  POSTHOG_PROJECT_TOKEN: telemetryEnv.shape.POSTHOG_PROJECT_TOKEN,
  POSTHOG_HOST: telemetryEnv.shape.POSTHOG_HOST,
});
