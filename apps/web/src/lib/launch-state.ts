import { defineEnv } from "@reranker/env";
import { gatedFlagsOn } from "@reranker/flags/launch-gate";
import { createPostHogApi } from "@reranker/flags/posthog-api";
import { loadJobsConfig } from "@reranker/jobs";
import { SourceError } from "@reranker/telemetry/digest";
import { launchEnv } from "@reranker/telemetry/env";
import { type GatedFlag, type LaunchInputs, tracerRegistered } from "@reranker/telemetry/launch";
import { CRONS } from "./crons";

/**
 * What only this deployment can say about itself: the crons it was built with, whether its
 * instrumentation registered a tracer, and the Resend quota it runs with.
 */
export function deploymentInputs(): LaunchInputs {
  return {
    crons: CRONS,
    tracing: tracerRegistered(),
    resendDailyQuota: loadJobsConfig().quotas["resend.emails"].daily,
  };
}

const key = launchEnv.pick({ POSTHOG_LAUNCH_READ_KEY: true });

/** Whether each gated flag is on in production, from its definition in PostHog. */
export async function readGatedFlags(): Promise<Record<GatedFlag, boolean>> {
  const apiKey = defineEnv([key]).POSTHOG_LAUNCH_READ_KEY;
  if (!apiKey) throw new SourceError("falta POSTHOG_LAUNCH_READ_KEY");
  return gatedFlagsOn(createPostHogApi(apiKey));
}
