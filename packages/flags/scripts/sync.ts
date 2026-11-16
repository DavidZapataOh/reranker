import { createPostHogApi } from "../src/posthog-api";
import { registry } from "../src/registry";
import { runSync } from "../src/sync";

// Creates the registry's missing flags in PostHog; run locally with a personal API key.
const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
if (!apiKey) {
  console.error("POSTHOG_PERSONAL_API_KEY (personal API key with feature_flag:write) is required");
  process.exit(1);
}

await runSync(createPostHogApi(apiKey), registry, { dryRun: process.argv.includes("--dry-run") });
