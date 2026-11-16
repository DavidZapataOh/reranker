import { createHash, timingSafeEqual } from "node:crypto";
import { appEnv, defineEnv } from "@reranker/env";
import { opsEnv } from "../env";

// Hashing first gives both sides one length, so the comparison leaks neither the secret nor its size.
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Gate for operational routes. Production answers 404 unless the request carries the cron bearer,
 * so the route does not exist for anyone else; previews sit behind Vercel deployment protection.
 */
export function opsGuard(req: Request): Response | null {
  if (appEnv() !== "production") return null;
  const { CRON_SECRET } = defineEnv([opsEnv]);
  const authorization = req.headers.get("authorization") ?? "";
  if (CRON_SECRET && sameSecret(authorization, `Bearer ${CRON_SECRET}`)) return null;
  return new Response(null, { status: 404 });
}
