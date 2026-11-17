import { defineEnv } from "@reranker/env";
import { authEnv } from "./env";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2048;
const ATTEMPT_TIMEOUT_MS = 5_000;
const ATTEMPTS = 2;

export type TurnstileAction = "free_report" | "lead_form";

export type TurnstileResult = { ok: true } | { ok: false; errorCodes: string[] };

interface SiteverifyResponse {
  success: boolean;
  action?: string;
  "error-codes"?: string[];
  metadata?: { result_with_testing_key?: boolean };
}

const secretEnv = authEnv.pick({ TURNSTILE_SECRET_KEY: true });

async function siteverify(body: string): Promise<SiteverifyResponse | undefined> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(SITEVERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (response.status < 500) return (await response.json()) as SiteverifyResponse;
    } catch {
      // A network failure or timeout is retried like a server error.
    }
  }
  return undefined;
}

/**
 * Validates a Turnstile token with Cloudflare's Siteverify API. A retry reuses the idempotency key
 * so Cloudflare does not reject the second attempt as a duplicate of the first.
 */
export async function verifyTurnstile(input: {
  token: string;
  remoteIp?: string;
  expectedAction: TurnstileAction;
}): Promise<TurnstileResult> {
  const { token, remoteIp, expectedAction } = input;
  if (token === "") return { ok: false, errorCodes: ["missing-input-response"] };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, errorCodes: ["invalid-input-response"] };

  const { TURNSTILE_SECRET_KEY } = defineEnv([secretEnv]);
  const result = await siteverify(
    JSON.stringify({
      secret: TURNSTILE_SECRET_KEY,
      response: token,
      ...(remoteIp ? { remoteip: remoteIp } : {}),
      idempotency_key: crypto.randomUUID(),
    }),
  );
  if (!result) return { ok: false, errorCodes: ["internal-error"] };
  if (!result.success) return { ok: false, errorCodes: result["error-codes"] ?? [] };
  // Cloudflare's testing secrets answer without an action; they accept only the dummy token, so a
  // real secret never produces this answer.
  if (result.action !== expectedAction && result.metadata?.result_with_testing_key !== true) {
    return { ok: false, errorCodes: ["action-mismatch"] };
  }
  return { ok: true };
}
