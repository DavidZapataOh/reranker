import { guardModeStatus, takeTokens, tripGuardMode } from "@reranker/jobs";
import { RateLimitedError } from "@reranker/jobs/errors";

// Bright Data blocks an IP for an hour at 25 429s in 5 minutes and warns from 10. Vercel functions
// can share an outbound IP, so the whole fleet stops at 10.
const WINDOW_MS = 5 * 60_000;
const LIMIT = 10;

export const RATE_GUARD = {
  bucket: "brightdata:429",
  mode: "brightdata-rate-limited",
} as const;

const limits = { capacity: LIMIT, refillPerSecond: LIMIT / (WINDOW_MS / 1000) };

/** Counts a 429 fleet-wide; the 10th within 5 minutes stops every Bright Data call for 5 minutes. */
export async function record429(): Promise<void> {
  const { ok, remaining } = await takeTokens(RATE_GUARD.bucket, limits);
  if (ok && remaining >= 1) return;
  await tripGuardMode(RATE_GUARD.mode, "429 burst", WINDOW_MS);
}

/** Refuses a call before it is sent while the fleet guard holds. */
export async function assertNotRateLimited(): Promise<void> {
  const { active, remainingMs } = await guardModeStatus(RATE_GUARD.mode);
  if (!active || remainingMs === null) return;
  throw new RateLimitedError(Math.max(1, remainingMs), "Bright Data");
}
