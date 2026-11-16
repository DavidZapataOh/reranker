import { readFileSync } from "node:fs";
import { createPostHogApi } from "../src/posthog-api";
import { registry } from "../src/registry";
import { runCheck } from "../src/sync";

// Fails when PostHog lacks a registry flag or the generated keys are stale; runs in CI.
const apiKey = process.env.POSTHOG_READONLY_API_KEY;
if (!apiKey) {
  console.error("POSTHOG_READONLY_API_KEY (personal API key with feature_flag:read) is required");
  process.exit(1);
}

const genFile = readFileSync(new URL("../src/flag-keys.gen.ts", import.meta.url), "utf8");
process.exit((await runCheck(createPostHogApi(apiKey), registry, genFile, new Date())) ? 0 : 1);
