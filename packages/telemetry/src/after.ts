import { after } from "next/server";
import { getPostHogServer } from "./posthog-server";
import { scrub } from "./scrub";

async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    try {
      await getPostHogServer().captureExceptionImmediate(error);
    } catch (reportFailure) {
      console.error(scrub(reportFailure));
    }
    console.error(scrub(error));
  }
}

/** Runs the task after the response is sent; telemetry failures are reported and never reach the caller. */
export function runAfter(fn: () => Promise<void>): void {
  try {
    after(() => guarded(fn));
  } catch {
    // Scripts and workflows run outside a request, where `after` is unavailable.
    void guarded(fn);
  }
}
