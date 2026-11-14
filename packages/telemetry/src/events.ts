import {
  type CaptureContext,
  type EventSubject,
  type ServerEventName,
  type ServerEventOf,
  sanitizeServerProps,
} from "@reranker/analytics";
import { appEnv } from "@reranker/env";
import { runAfter } from "./after";
import { getPostHogServer } from "./posthog-server";
import { scrub } from "./scrub";

function distinctId(subject: EventSubject): string {
  if ("system" in subject) return "system";
  if ("report" in subject) return `report:${subject.report}`;
  if ("lead" in subject) return `lead:${subject.lead}`;
  return `user:${subject.user}`;
}

/**
 * Sends a catalogued server event after the response. Only production sends; any other
 * environment, an unknown event or a delivery failure is silent so telemetry never breaks a request.
 */
export function captureServerEvent<N extends ServerEventName>(
  event: ServerEventOf<N>,
  ctx: CaptureContext,
): void {
  try {
    const env = appEnv();
    if (env !== "production") return;
    const sanitized = sanitizeServerProps(event.name, event.props);
    if (!sanitized) return;
    const message = {
      distinctId: distinctId(ctx.subject),
      event: event.name,
      properties: scrub({ ...sanitized.props, app_env: env }),
    };
    runAfter(() => getPostHogServer().captureImmediate(message));
  } catch (error) {
    console.error(scrub(error));
  }
}
