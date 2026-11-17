import { createHmac } from "node:crypto";
import { isIPv4 } from "node:net";
import { defineEnv } from "@reranker/env";
import {
  type BucketLimits,
  consumeQuota,
  QuotaExceededError,
  refundTokens,
  takeTokens,
} from "@reranker/jobs";
import type { GenericEndpointContext } from "better-auth";
import { APIError, getIP } from "better-auth/api";
import { checkEmailDomain } from "./email-domain";
import { authEnv } from "./env";

const HOUR = 3_600;
const DAY = 86_400;
const perWindow = (capacity: number, seconds: number): BucketLimits => ({
  capacity,
  refillPerSecond: capacity / seconds,
});

const LIMITS = {
  emailHour: perWindow(3, HOUR),
  emailDay: perWindow(5, DAY),
  ip: perWindow(5, DAY),
  network: perWindow(15, DAY),
};

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

const hmacEnv = authEnv.pick({ CAPACITY_HMAC_KEY: true });

export type OtpSendRejection = "disposable" | "no_mx" | "rate_limited" | "quota";

type GuardContext = Pick<GenericEndpointContext, "body" | "headers" | "request"> & {
  context: Pick<GenericEndpointContext["context"], "options">;
};

/** The mailbox an address delivers to, so its variants share one limit. */
export function normalizeEmailForLimits(email: string): string {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  const domain = address.slice(at + 1);
  if (at === -1 || !GMAIL_DOMAINS.has(domain)) return address;
  // Gmail ignores dots and everything after a plus in the local part.
  const local = address.slice(0, at).split("+", 1)[0]?.replaceAll(".", "") ?? "";
  return `${local}@gmail.com`;
}

// Better Auth's getIP already collapses IPv6 to its /64; /48 is the IPv6 counterpart of an IPv4 /24.
function networkOf(ip: string): string {
  if (isIPv4(ip)) return `${ip.split(".").slice(0, 3).join(".")}.0/24`;
  return `${ip.split(":").slice(0, 3).join(":")}::/48`;
}

function reject(
  status: "BAD_REQUEST" | "TOO_MANY_REQUESTS" | "SERVICE_UNAVAILABLE",
  reason: OtpSendRejection,
  retryAfterSeconds?: number,
): APIError {
  return new APIError(
    status,
    { code: "EMAIL_CODE_NOT_SENT", message: `Sign-in code not sent: ${reason}`, reason },
    retryAfterSeconds === undefined ? {} : { "X-Retry-After": String(retryAfterSeconds) },
  );
}

/**
 * Runs before a sign-in code is created: domain, then send limits, then the daily email quota.
 * Turnstile has already run in the captcha plugin's onRequest. A rejection sends nothing and gives
 * back every token it took.
 */
export async function guardOtpSend(ctx: GuardContext): Promise<void> {
  const email = (ctx.body as { email?: unknown } | undefined)?.email;
  // An invalid body is the endpoint's to reject.
  if (typeof email !== "string") return;

  const domain = await checkEmailDomain(email);
  if (!domain.ok) throw reject("BAD_REQUEST", domain.reason);

  const { CAPACITY_HMAC_KEY } = defineEnv([hmacEnv]);
  const opaque = (value: string) =>
    createHmac("sha256", CAPACITY_HMAC_KEY).update(value).digest("base64url");
  const mailbox = opaque(normalizeEmailForLimits(email));
  const ip = getIP(ctx.request ?? ctx.headers ?? new Headers(), ctx.context.options);
  const buckets: { key: string; limits: BucketLimits }[] = [
    { key: `otp:email:hour:${mailbox}`, limits: LIMITS.emailHour },
    { key: `otp:email:day:${mailbox}`, limits: LIMITS.emailDay },
    ...(ip
      ? [
          { key: `otp:ip:${opaque(ip)}`, limits: LIMITS.ip },
          { key: `otp:net:${opaque(networkOf(ip))}`, limits: LIMITS.network },
        ]
      : []),
  ];

  const results = await Promise.all(buckets.map(({ key, limits }) => takeTokens(key, limits)));
  const taken = buckets.filter((_, i) => results[i]?.ok);
  const giveBack = () =>
    Promise.all(taken.map(({ key, limits }) => refundTokens(key, limits))).then(() => undefined);

  if (taken.length < buckets.length) {
    await giveBack();
    const waitMs = Math.max(...results.filter((r) => !r.ok).map((r) => r.retryAfterMs));
    throw reject("TOO_MANY_REQUESTS", "rate_limited", Math.max(1, Math.ceil(waitMs / 1000)));
  }

  try {
    await consumeQuota("resend.emails", { priority: "critical" });
  } catch (error) {
    if (!(error instanceof QuotaExceededError)) throw error;
    await giveBack();
    const waitSeconds = Math.ceil((error.resetsAt.getTime() - Date.now()) / 1000);
    throw reject("SERVICE_UNAVAILABLE", "quota", Math.max(1, waitSeconds));
  }
}
