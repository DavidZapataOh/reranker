import type { ServerEventProps } from "@reranker/analytics";
import { recordVelocity } from "@reranker/jobs/velocity";
import { cost } from "@reranker/schema";
import { captureServerEvent, log, type OpsAlertKind, sendOpsAlert } from "@reranker/telemetry";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";

type Window = { count10m: number; flagged10m: number };
type SignInMethod = ServerEventProps<"auth_sign_in">["method"];
type FailureReason = ServerEventProps<"auth_sign_in_failed">["reason"];

const SEND_CODE_PATH = "/email-otp/send-verification-otp";
const SIGN_IN_PATHS: Record<string, SignInMethod> = {
  "/sign-in/email-otp": "email_otp",
  "/callback/:id": "google",
  "/one-tap/callback": "one_tap",
};
const CODE_FAILURES: Record<string, FailureReason> = {
  OTP_EXPIRED: "otp_expired",
  INVALID_OTP: "invalid_otp",
  TOO_MANY_ATTEMPTS: "too_many_attempts",
};
const NO_SPEND = cost(0, "USD");

/** Better Auth creates the user and its first session in the same request, a few ms apart. */
export function isNewUser(session: { createdAt: Date }, user: { createdAt: Date }): boolean {
  return session.createdAt.getTime() - user.createdAt.getTime() < 5_000;
}

export function shouldAlertSignInFailures(w: Window): boolean {
  return w.count10m >= 20 && w.flagged10m / w.count10m > 0.3;
}

export function shouldAlertEmailDelivery(w: Window): boolean {
  return w.count10m >= 10 && w.flagged10m / w.count10m > 0.05;
}

// Only the attempt that crosses the threshold alerts, so a spike raises one alert instead of one
// per failure for as long as it lasts.
async function recordAttempt(
  key: string,
  failed: boolean,
  shouldAlert: (w: Window) => boolean,
  kind: OpsAlertKind,
): Promise<void> {
  try {
    const now = await recordVelocity(key, { flagged: failed, spend: NO_SPEND });
    const before = { count10m: now.count10m - 1, flagged10m: now.flagged10m - (failed ? 1 : 0) };
    if (!shouldAlert(now) || shouldAlert(before)) return;
    await sendOpsAlert(kind, { attempts_10m: now.count10m, failed_10m: now.flagged10m });
  } catch (error) {
    log.warn("auth.velocity_failed", {
      key,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

export function recordSignInAttempt(failed: boolean): Promise<void> {
  return recordAttempt(
    "auth.sign_in",
    failed,
    shouldAlertSignInFailures,
    "auth-sign-in-failure-spike",
  );
}

export function recordEmailDelivery(delivered: boolean): Promise<void> {
  return recordAttempt("auth.email", !delivered, shouldAlertEmailDelivery, "auth-email-delivery");
}

type SignInOutcome =
  | { ok: true; method: SignInMethod; userId: string; newUser: boolean }
  | { ok: false; method: SignInMethod; reason: FailureReason };

// The OAuth callback reports every failure as a redirect to the error page with ?error=.
function redirectsWithError(returned: {
  headers?: ConstructorParameters<typeof Headers>[0];
}): boolean {
  const location = new Headers(returned.headers).get("location");
  return location !== null && URL.canParse(location) && new URL(location).searchParams.has("error");
}

/** What a finished request on a sign-in route amounts to; null when it was not a sign-in attempt. */
export function signInOutcome(input: {
  path: string;
  params: Record<string, string | undefined> | undefined;
  newSession: { session: { createdAt: Date }; user: { id: string; createdAt: Date } } | null;
  returned: unknown;
}): SignInOutcome | null {
  const method = Object.hasOwn(SIGN_IN_PATHS, input.path) ? SIGN_IN_PATHS[input.path] : undefined;
  if (!method) return null;
  // Google is the only social provider; another one needs its own method in the catalog first.
  if (input.path === "/callback/:id" && input.params?.id !== "google") return null;
  const { newSession, returned } = input;
  if (newSession) {
    const { session, user } = newSession;
    return { ok: true, method, userId: user.id, newUser: isNewUser(session, user) };
  }
  if (!isAPIError(returned)) return null;
  if (method === "email_otp") {
    const code = (returned.body as { code?: string } | undefined)?.code;
    const reason = code && Object.hasOwn(CODE_FAILURES, code) ? CODE_FAILURES[code] : undefined;
    return reason ? { ok: false, method, reason } : null;
  }
  if (method === "google" && !redirectsWithError(returned)) return null;
  return { ok: false, method, reason: "oauth_error" };
}

const withHeaders = (headers: Headers | undefined) => (headers ? { headers } : {});

/** Auth events and failure alerts. No event carries the address: a user is named by id only. */
export function authTelemetry() {
  return {
    id: "auth-telemetry",
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === SEND_CODE_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            captureServerEvent(
              { name: "auth_code_sent", props: {} },
              { ...withHeaders(ctx.headers), subject: { system: true } },
            );
          }),
        },
        {
          matcher: (ctx) => Object.hasOwn(SIGN_IN_PATHS, ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const outcome = signInOutcome({
              path: ctx.path,
              params: ctx.params,
              newSession: ctx.context.newSession,
              returned: ctx.context.returned,
            });
            if (!outcome) return;
            if (outcome.ok) {
              captureServerEvent(
                {
                  name: "auth_sign_in",
                  props: { method: outcome.method, new_user: outcome.newUser },
                },
                { ...withHeaders(ctx.headers), subject: { user: outcome.userId } },
              );
            } else {
              captureServerEvent(
                { name: "auth_sign_in_failed", props: { reason: outcome.reason } },
                { ...withHeaders(ctx.headers), subject: { system: true } },
              );
            }
            ctx.context.runInBackground(recordSignInAttempt(!outcome.ok));
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
