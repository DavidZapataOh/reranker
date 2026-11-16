import type { OnRequestErrorOptions } from "@posthog/next";
import type { EnvSource } from "@reranker/env";
import { scrub, scrubEvent } from "@reranker/telemetry/scrub";

/** How @posthog/next reports the errors Next.js sees: server project, no IP or geo, personal data redacted. */
export function requestErrorOptions(source: EnvSource = process.env): OnRequestErrorOptions {
  const token = source.POSTHOG_PROJECT_TOKEN || undefined;
  const host = source.POSTHOG_HOST || undefined;
  return {
    ...(token ? { apiKey: token } : {}),
    ...(host ? { host } : {}),
    // Development has no project token by design; without this the SDK falls back to the browser key.
    disabled: token === undefined,
    serverOptions: { before_send: scrubEvent, disableGeoip: true },
    beforeCapture: ({ properties }) => scrub(properties),
  };
}
