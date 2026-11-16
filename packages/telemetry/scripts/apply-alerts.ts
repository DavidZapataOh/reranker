import { readFileSync } from "node:fs";
import { applyAlerts } from "../src/alerts-apply";
import { DesiredAlerts } from "../src/alerts-plan";
import { createPostHogRest } from "../src/posthog-rest";

// Reconciles PostHog insight alerts with posthog-alerts.json; run locally with a personal API key.
const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
if (!apiKey) {
  console.error(
    "POSTHOG_PERSONAL_API_KEY (personal API key with insight:read, insight:write, alert:read and alert:write) is required",
  );
  process.exit(1);
}

const desired = DesiredAlerts.parse(
  JSON.parse(readFileSync(new URL("../posthog-alerts.json", import.meta.url), "utf8")),
);

await applyAlerts(createPostHogRest(apiKey), desired, {
  dryRun: process.argv.includes("--dry-run"),
  log: console.log,
});
