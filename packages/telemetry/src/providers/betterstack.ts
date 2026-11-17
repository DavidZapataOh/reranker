import { httpError } from "./source-error";

const ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tells Better Stack the daily run finished: a plain request to the heartbeat URL
 * (https://betterstack.com/docs/uptime/cron-and-heartbeat-monitor/). Nothing else pings that day,
 * so a transient failure is retried instead of raising a false `heartbeat-missed`.
 */
export async function pingHeartbeat(
  url: string,
  { backoffMs = 1_000 }: { backoffMs?: number } = {},
): Promise<void> {
  let failure: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.ok) return;
      failure = httpError(response);
    } catch (error) {
      failure = error;
    }
    if (attempt < ATTEMPTS) await wait(backoffMs * attempt);
  }
  throw failure;
}
