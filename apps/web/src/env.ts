import { authEnv } from "@reranker/auth/env";
import { captureEnv } from "@reranker/capture/env";
import { config, defineEnv, forbiddenIn, requiredIn, secret } from "@reranker/env";
import { flagsEnv } from "@reranker/flags/env";
import { jobsEnv } from "@reranker/jobs/env";
import { z } from "@reranker/schema";
import { digestEnv, launchEnv, telemetryEnv } from "@reranker/telemetry/env";

// The landing reads these through NEXT_PUBLIC_* at build time; they are declared here so a
// deployment missing one fails before it serves traffic.
export const webEnv = z.object({
  NEXT_PUBLIC_POSTHOG_KEY: requiredIn(
    ["preview", "production"],
    config(z.string().startsWith("phc_"), "PostHog project key for the browser"),
  ),
  NEXT_PUBLIC_POSTHOG_REGION: config(
    z.enum(["us", "eu"]).default("us"),
    "PostHog cloud region, us unless the project lives in the EU",
  ),
  // Measured on the production deployment only, so previews never pollute the audience.
  NEXT_PUBLIC_GA_ID: forbiddenIn(
    ["preview", "development"],
    config(z.string(), "Google Analytics 4 measurement id"),
  ),
  NEXT_PUBLIC_CLARITY_ID: forbiddenIn(
    ["preview", "development"],
    config(z.string(), "Microsoft Clarity project id"),
  ),
});

export const opsEnv = z.object({
  CRON_SECRET: requiredIn(
    ["production"],
    secret(z.string().min(16), "Bearer that Vercel Cron and operators send to protected routes"),
  ),
});

export const fragments = [
  webEnv,
  telemetryEnv,
  digestEnv,
  launchEnv,
  flagsEnv,
  opsEnv,
  jobsEnv,
  authEnv,
  // After digestEnv, which declares the same DataForSEO credentials as optional: the last
  // declaration wins, so capture makes them mandatory where it runs.
  captureEnv,
] as const;

let validated: ReturnType<typeof compose> | undefined;

function compose() {
  return defineEnv(fragments);
}

/** Validates on first use, so the build and `register()` decide when it runs. */
export function getEnv() {
  validated ??= compose();
  return validated;
}
