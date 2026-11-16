import { createHash, timingSafeEqual } from "node:crypto";
import { appEnv, defineEnv, EnvValidationError } from "@reranker/env";
import { opsEnv } from "../env";

// Hashing first gives both sides one length, so the comparison leaks neither the secret nor its size.
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function cronSecret(): string | undefined {
  try {
    return defineEnv([opsEnv]).CRON_SECRET;
  } catch (error) {
    // Startup already refuses a production deployment without the secret; a request still
    // gets a closed door instead of a 500.
    if (error instanceof EnvValidationError) return undefined;
    throw error;
  }
}

/** True when the request carries the cron bearer; always false while the secret is unset. */
export function hasCronBearer(req: Request): boolean {
  const secret = cronSecret();
  if (!secret) return false;
  return sameSecret(req.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

/**
 * Gate for operational routes. Production answers 404 unless the request carries the cron bearer,
 * so the route does not exist for anyone else; previews sit behind Vercel deployment protection.
 */
export function opsGuard(req: Request): Response | null {
  if (appEnv() !== "production" || hasCronBearer(req)) return null;
  return new Response(null, { status: 404 });
}
