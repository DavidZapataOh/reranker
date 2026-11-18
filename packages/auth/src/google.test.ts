import type { BetterAuthOptions } from "better-auth";
import { describe, expect, test, vi } from "vitest";

vi.stubEnv("APP_ENV", "development");
vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(32));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "google-client-id.apps.googleusercontent.com");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
vi.stubEnv("RESEND_API_KEY", "re_test");
vi.stubEnv("TURNSTILE_SECRET_KEY", "turnstile-secret");
vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "turnstile-site");
vi.stubEnv("CAPACITY_HMAC_KEY", "h".repeat(32));

const { auth } = await import("./server");

type Gate = NonNullable<NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]>;
const gate = (auth.options as BetterAuthOptions).user?.validateUserInfo as Gate;
const validate = async (data: Parameters<Gate>[0]) => gate(data, {} as Parameters<Gate>[1]);

const googleSource = (action: "create-user" | "link-account" | "sign-in") => ({
  method: "oauth" as const,
  action,
  oauth: { providerId: "google" },
});

describe("Google sign-in", () => {
  // signInSocial stores its state in the database; the full round trip runs in the integration test.
  test("the authorization URL asks only for openid email profile, select_account, no offline", async () => {
    const context = await auth.$context;
    const google = context.socialProviders.find((provider) => provider.id === "google");
    if (!google) throw new Error("the Google provider is not registered");
    const authorization = await google.createAuthorizationURL({
      state: "state",
      codeVerifier: "v".repeat(43),
      redirectURI: "http://localhost:3000/api/auth/callback/google",
    });
    expect(authorization.origin + authorization.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(authorization.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "email",
      "openid",
      "profile",
    ]);
    expect(authorization.searchParams.get("client_id")).toBe(
      "google-client-id.apps.googleusercontent.com",
    );
    expect(authorization.searchParams.get("prompt")).toBe("select_account");
    expect(authorization.searchParams.get("access_type")).toBeNull();
    expect(authorization.searchParams.get("include_granted_scopes")).toBeNull();
  });

  test("One Tap is served and checks Google's tokens against the same web client", () => {
    const oneTap = auth.options.plugins.find((plugin) => plugin.id === "one-tap");
    expect(oneTap).toBeDefined();
    // No client id of its own (it reads the Google provider's) and sign-up stays open.
    expect(oneTap?.options).toBeUndefined();
    expect(typeof auth.api.oneTapCallback).toBe("function");
  });

  test("unverified Google emails are refused and Google links to an existing user", () => {
    expect(auth.options.socialProviders?.google).toMatchObject({ requireEmailVerification: true });
    expect(auth.options.account?.accountLinking).toMatchObject({
      enabled: true,
      trustedProviders: ["google"],
    });
  });

  // A trusted provider links on email alone, so Google's own email_verified claim is the guard.
  test.each(["create-user", "link-account", "sign-in"] as const)(
    "a Google identity whose email Google has not verified is refused on %s",
    async (action) => {
      await expect(
        validate({
          user: { email: "ana@example.com", emailVerified: false },
          source: googleSource(action),
        }),
      ).resolves.toMatchObject({ error: "email_not_verified" });
    },
  );

  test("a Google identity with a verified email is admitted", async () => {
    await expect(
      validate({
        user: { email: "ana@example.com", emailVerified: true },
        source: googleSource("link-account"),
      }),
    ).resolves.toBeUndefined();
  });

  test("sign-in codes are not gated: the code itself proves the address", async () => {
    await expect(
      validate({
        user: { email: "ana@example.com", emailVerified: false },
        source: { method: "email-otp", action: "create-user" },
      }),
    ).resolves.toBeUndefined();
  });
});
