import { defineEnv } from "@reranker/env";
import { PostHog } from "posthog-node";
import { telemetryEnv } from "./env";
import { scrubEvent } from "./scrub";

// Next bundles route handlers and instrumentation separately, so the singleton lives on globalThis.
const CLIENT = Symbol.for("reranker.telemetry.posthog");
type Holder = typeof globalThis & { [CLIENT]?: PostHog };

/** The one PostHog client of the process, created on first use from the validated environment. */
export function getPostHogServer(): PostHog {
  const holder = globalThis as Holder;
  holder[CLIENT] ??= create();
  return holder[CLIENT];
}

function create(): PostHog {
  const env = defineEnv([telemetryEnv]);
  const token = env.POSTHOG_PROJECT_TOKEN;
  return new PostHog(token ?? "phc_unset", {
    ...(env.POSTHOG_HOST ? { host: env.POSTHOG_HOST } : {}),
    // Server functions are short-lived: send each event at once instead of batching.
    flushAt: 1,
    flushInterval: 0,
    enableExceptionAutocapture: process.env.NEXT_RUNTIME === "nodejs",
    disableGeoip: true,
    before_send: scrubEvent,
    // Development has no project token by design; the client then sends nothing.
    disabled: token === undefined,
  });
}

/** Drops the cached client so a test can build another one. */
export function resetPostHogServer(): void {
  delete (globalThis as Holder)[CLIENT];
}
