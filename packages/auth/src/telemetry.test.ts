import { BANNED_PROPERTY_KEYS, SERVER_EVENT_KEYS } from "@reranker/analytics";
import { cost } from "@reranker/schema";
import { APIError } from "better-auth/api";
import { afterEach, describe, expect, test, vi } from "vitest";

const velocity = vi.hoisted(() => ({ recordVelocity: vi.fn() }));
vi.mock("@reranker/jobs/velocity", () => velocity);

const telemetry = vi.hoisted(() => ({
  captureServerEvent: vi.fn(),
  sendOpsAlert: vi.fn(),
  log: { warn: vi.fn() },
}));
vi.mock("@reranker/telemetry", () => telemetry);

const {
  authTelemetry,
  isNewUser,
  recordEmailDelivery,
  recordSignInAttempt,
  shouldAlertEmailDelivery,
  shouldAlertSignInFailures,
  signInOutcome,
} = await import("./telemetry");

afterEach(() => {
  vi.clearAllMocks();
});

const windows = (count10m: number, flagged10m: number) => ({
  count10m,
  flagged10m,
  spend10m: cost(0, "USD"),
  spend60m: cost(0, "USD"),
});

describe("alert thresholds", () => {
  test.each([
    [{ count10m: 20, flagged10m: 7 }, true],
    [{ count10m: 20, flagged10m: 6 }, false],
    [{ count10m: 19, flagged10m: 19 }, false],
  ])("sign-in failure spike %o → %s", (w, out) => {
    expect(shouldAlertSignInFailures(w)).toBe(out);
  });

  test("email delivery alert on > 5 % send errors with at least 10 sends", () => {
    expect(shouldAlertEmailDelivery({ count10m: 20, flagged10m: 2 })).toBe(true);
    expect(shouldAlertEmailDelivery({ count10m: 20, flagged10m: 1 })).toBe(false);
    expect(shouldAlertEmailDelivery({ count10m: 9, flagged10m: 9 })).toBe(false);
  });
});

test("isNewUser", () => {
  const user = { createdAt: new Date("2026-11-17T12:00:00Z") };
  expect(isNewUser({ createdAt: new Date("2026-11-17T12:00:01Z") }, user)).toBe(true);
  expect(isNewUser({ createdAt: new Date("2026-11-18T12:00:00Z") }, user)).toBe(false);
});

test("no auth event carries an email or any other personal field", () => {
  const authEvents = [
    "auth_code_sent",
    "auth_sign_in",
    "auth_sign_in_failed",
    "auth_rate_limited",
    "data_policy_accepted",
    "account_ready",
    "account_deleted",
    "auth_email_failed",
  ] as const;
  const banned = new Set<string>(BANNED_PROPERTY_KEYS);
  for (const name of authEvents) {
    for (const key of SERVER_EVENT_KEYS[name])
      expect(banned.has(key), `${name}.${key}`).toBe(false);
  }
});

describe("signInOutcome", () => {
  const user = { id: "u-1", createdAt: new Date("2026-11-17T12:00:00Z") };
  const newSession = { session: { createdAt: new Date("2026-11-17T12:00:01Z") }, user };
  const otpError = (code: string) =>
    new APIError("BAD_REQUEST", { code, message: code.toLowerCase() });
  const redirect = (location: string) => new APIError("FOUND", undefined, { location });

  test.each([
    ["/sign-in/email-otp", {}, "email_otp"],
    ["/callback/:id", { id: "google" }, "google"],
    ["/one-tap/callback", {}, "one_tap"],
  ] as const)("a new session on %s is a sign-in with %s", (path, params, method) => {
    expect(signInOutcome({ path, params, newSession, returned: undefined })).toEqual({
      ok: true,
      method,
      userId: "u-1",
      newUser: true,
    });
  });

  test.each([
    ["OTP_EXPIRED", "otp_expired"],
    ["INVALID_OTP", "invalid_otp"],
    ["TOO_MANY_ATTEMPTS", "too_many_attempts"],
  ])("code error %s is %s", (code, reason) => {
    expect(
      signInOutcome({
        path: "/sign-in/email-otp",
        params: {},
        newSession: null,
        returned: otpError(code),
      }),
    ).toEqual({ ok: false, method: "email_otp", reason });
  });

  test("a malformed code request is not a sign-in attempt", () => {
    expect(
      signInOutcome({
        path: "/sign-in/email-otp",
        params: {},
        newSession: null,
        returned: otpError("VALIDATION_ERROR"),
      }),
    ).toBeNull();
  });

  test("a Google callback that redirects with an error is an oauth_error", () => {
    expect(
      signInOutcome({
        path: "/callback/:id",
        params: { id: "google" },
        newSession: null,
        returned: redirect("http://localhost:3000/api/auth/error?error=email_not_verified"),
      }),
    ).toEqual({ ok: false, method: "google", reason: "oauth_error" });
  });

  test("a Google callback that only re-posts to itself is not an attempt", () => {
    expect(
      signInOutcome({
        path: "/callback/:id",
        params: { id: "google" },
        newSession: null,
        returned: redirect("http://localhost:3000/api/auth/callback/google?code=c&state=s"),
      }),
    ).toBeNull();
  });

  test("another provider's callback is not counted as Google", () => {
    expect(
      signInOutcome({
        path: "/callback/:id",
        params: { id: "github" },
        newSession,
        returned: undefined,
      }),
    ).toBeNull();
  });

  test("a rejected One Tap token is an oauth_error", () => {
    expect(
      signInOutcome({
        path: "/one-tap/callback",
        params: {},
        newSession: null,
        returned: new APIError("BAD_REQUEST", { message: "invalid id token" }),
      }),
    ).toEqual({ ok: false, method: "one_tap", reason: "oauth_error" });
  });

  test("other paths are ignored", () => {
    expect(
      signInOutcome({ path: "/get-session", params: {}, newSession, returned: undefined }),
    ).toBeNull();
  });
});

describe("recordSignInAttempt", () => {
  test("alerts once, on the failure that crosses the threshold", async () => {
    velocity.recordVelocity.mockResolvedValueOnce(windows(20, 7));
    await recordSignInAttempt(true);
    expect(velocity.recordVelocity).toHaveBeenCalledWith("auth.sign_in", {
      flagged: true,
      spend: cost(0, "USD"),
    });
    expect(telemetry.sendOpsAlert).toHaveBeenCalledExactlyOnceWith("auth-sign-in-failure-spike", {
      attempts_10m: 20,
      failed_10m: 7,
    });

    velocity.recordVelocity.mockResolvedValueOnce(windows(21, 8));
    await recordSignInAttempt(true);
    expect(telemetry.sendOpsAlert).toHaveBeenCalledOnce();
  });

  test("a success never alerts by itself", async () => {
    velocity.recordVelocity.mockResolvedValueOnce(windows(21, 7));
    await recordSignInAttempt(false);
    expect(telemetry.sendOpsAlert).not.toHaveBeenCalled();
  });

  test("never throws when the velocity store fails", async () => {
    velocity.recordVelocity.mockRejectedValueOnce(new Error("pool exhausted"));
    await expect(recordSignInAttempt(true)).resolves.toBeUndefined();
    expect(telemetry.log.warn).toHaveBeenCalledWith("auth.velocity_failed", {
      key: "auth.sign_in",
      error: "Error",
    });
  });
});

describe("recordEmailDelivery", () => {
  test("a failed send is flagged and the crossing alerts on email delivery", async () => {
    velocity.recordVelocity.mockResolvedValueOnce(windows(10, 1));
    await recordEmailDelivery(false);
    expect(velocity.recordVelocity).toHaveBeenCalledWith("auth.email", {
      flagged: true,
      spend: cost(0, "USD"),
    });
    expect(telemetry.sendOpsAlert).toHaveBeenCalledExactlyOnceWith("auth-email-delivery", {
      attempts_10m: 10,
      failed_10m: 1,
    });
  });

  test("a delivered email is not flagged", async () => {
    velocity.recordVelocity.mockResolvedValueOnce(windows(1, 0));
    await recordEmailDelivery(true);
    expect(velocity.recordVelocity).toHaveBeenCalledWith("auth.email", {
      flagged: false,
      spend: cost(0, "USD"),
    });
    expect(telemetry.sendOpsAlert).not.toHaveBeenCalled();
  });
});

test("the plugin watches code sends and every sign-in route after they run", () => {
  const plugin = authTelemetry();
  expect(plugin.id).toBe("auth-telemetry");
  const watched = ["/email-otp/send-verification-otp", "/sign-in/email-otp", "/callback/:id"];
  for (const path of [...watched, "/one-tap/callback"]) {
    expect(
      plugin.hooks.after.some((hook) => hook.matcher({ path } as never)),
      path,
    ).toBe(true);
  }
  expect(plugin.hooks.after.some((hook) => hook.matcher({ path: "/get-session" } as never))).toBe(
    false,
  );
});
