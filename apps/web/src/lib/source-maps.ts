import { withPostHogConfig } from "@posthog/nextjs-config";
import { appEnv, type EnvSource } from "@reranker/env";

// withWorkflow resolves the config per phase, so this wrapper receives a config function.
type NextConfigInput = Parameters<typeof withPostHogConfig>[0];

/**
 * Deployed builds that hold the PostHog personal key upload their source maps, so stack traces
 * resolve to the original files; without the key the build ships unchanged instead of failing.
 */
export function withSourceMaps(
  config: NextConfigInput,
  source: EnvSource = process.env,
): NextConfigInput {
  const { POSTHOG_API_KEY, POSTHOG_PROJECT_ID, NEXT_PUBLIC_POSTHOG_REGION, VERCEL_GIT_COMMIT_SHA } =
    source;
  if (appEnv(source) === "development" || !POSTHOG_API_KEY || !POSTHOG_PROJECT_ID) return config;
  return withPostHogConfig(config, {
    personalApiKey: POSTHOG_API_KEY,
    projectId: POSTHOG_PROJECT_ID,
    host: `https://${NEXT_PUBLIC_POSTHOG_REGION === "eu" ? "eu" : "us"}.posthog.com`,
    sourcemaps: {
      enabled: true,
      ...(VERCEL_GIT_COMMIT_SHA ? { releaseVersion: VERCEL_GIT_COMMIT_SHA } : {}),
      deleteAfterUpload: true,
    },
  });
}
