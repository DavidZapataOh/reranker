import { setTimeout as sleep } from "node:timers/promises";
import { endPools } from "@reranker/db";
import { RateLimitedError } from "../src/errors";
import { type NetworkRangesRefresh, refreshNetworkRanges } from "../src/network";

const ATTEMPTS = 4;
// A pipeline cannot wait out a whole rate limit window the way the daily step can.
const MAX_WAIT_MS = 5 * 60_000;
const NETWORK_RETRY_MS = 5_000;

async function refresh(): Promise<NetworkRangesRefresh> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await refreshNetworkRanges(fetch, {
        attempt,
        onAlert: ({ payload }) =>
          console.log(`::warning::network ranges: ${JSON.stringify(payload)}`),
      });
    } catch (error) {
      const wait = error instanceof RateLimitedError ? error.retryAfterMs : NETWORK_RETRY_MS;
      if (attempt === ATTEMPTS || wait > MAX_WAIT_MS) throw error;
      console.log(`Attempt ${attempt} failed (${String(error)}), retrying in ${wait} ms`);
      await sleep(wait);
    }
  }
}

/** Loads the network lists into the database of DATABASE_URL_SYSTEM, retrying like the daily step. */
async function main(): Promise<void> {
  try {
    const started = performance.now();
    const result = await refresh();
    console.log(JSON.stringify({ ...result, ms: Math.round(performance.now() - started) }));
    if (result.rows === 0) throw new Error("No network ranges were loaded");
  } finally {
    await endPools();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
