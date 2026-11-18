import type { BetterAuthOptions } from "better-auth";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SIGN_IN_CODE_TTL_SECONDS } from "./sign-in-code";

const email = vi.hoisted(() => ({ sendAuthEmail: vi.fn() }));
vi.mock("./send-auth-email", () => email);

vi.stubEnv("APP_ENV", "development");
vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(32));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "google-client-id.apps.googleusercontent.com");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
vi.stubEnv("RESEND_API_KEY", "re_test");
vi.stubEnv("TURNSTILE_SECRET_KEY", "turnstile-secret");
vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "turnstile-site");
vi.stubEnv("CAPACITY_HMAC_KEY", "h".repeat(32));

const { auth, trustedOrigins } = await import("./server");
const { AUTH_RATE_RULES } = await import("./rate-limits");
const { waitUntil } = await import("@vercel/functions");

afterEach(() => {
  vi.clearAllMocks();
});

function plugin(id: string) {
  const found = auth.options.plugins.find((entry) => entry.id === id);
  if (!found) throw new Error(`plugin ${id} is not registered`);
  return found as typeof found & { options: Record<string, unknown> };
}

describe("auth configuration", () => {
  test("session and cookie configuration", () => {
    expect(auth.options.session).toMatchObject({
      expiresIn: 2_592_000,
      updateAge: 86_400,
      freshAge: 3_600,
      cookieCache: { enabled: true, maxAge: 300, strategy: "compact" },
    });
    expect(auth.options.advanced).toMatchObject({
      cookiePrefix: "rr",
      database: { generateId: "uuid", joins: true },
      ipAddress: { ipAddressHeaders: ["x-real-ip", "x-forwarded-for"] },
    });
  });

  test("only the app origin is trusted", () => {
    expect(trustedOrigins).toEqual(["http://localhost:3000"]);
    expect(auth.options.baseURL).toBe("http://localhost:3000");
  });

  test("background work is handed to waitUntil", () => {
    expect(auth.options.advanced?.backgroundTasks?.handler).toBe(waitUntil);
  });

  test("database-backed rate limits with the auth rules", () => {
    expect(auth.options.rateLimit).toMatchObject({
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: AUTH_RATE_RULES,
    });
    expect(AUTH_RATE_RULES).toEqual({
      "/email-otp/send-verification-otp": { window: 600, max: 3 },
      "/email-otp/request-password-reset": { window: 600, max: 3 },
      "/forget-password/email-otp": { window: 600, max: 3 },
      "/email-otp/request-email-change": { window: 600, max: 3 },
      "/send-verification-email": { window: 600, max: 3 },
      "/sign-in/email-otp": { window: 60, max: 5 },
      "/sign-in/social": { window: 60, max: 10 },
      "/delete-user": { window: 3600, max: 3 },
    });
  });

  test("no password sign-in is registered", () => {
    expect((auth.options as BetterAuthOptions).emailAndPassword?.enabled).not.toBe(true);
  });

  // Better Auth mounts these whatever the config says; without password sign-in none has a use.
  test.each([
    "/sign-in/email",
    "/sign-up/email",
    "/change-password",
    "/request-password-reset",
    "/reset-password",
    "/verify-password",
    "/email-otp/request-password-reset",
    "/forget-password/email-otp",
    "/email-otp/reset-password",
  ])("the password route %s answers 404", async (path) => {
    const response = await auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(404);
  });

  test("account deletion stays off until it can refuse the last owner of the house", () => {
    expect((auth.options as BetterAuthOptions).user?.deleteUser?.enabled).not.toBe(true);
  });

  test("organization deletion is rejected until it can protect the house", async () => {
    await expect(
      auth.api.deleteOrganization({
        body: { organizationId: crypto.randomUUID() },
        headers: new Headers(),
      }),
    ).rejects.toMatchObject({ statusCode: 404, body: { code: "ORGANIZATION_DELETION_DISABLED" } });
  });

  test("nextCookies is the last plugin, right after the auth telemetry", () => {
    expect(auth.options.plugins.slice(-2).map((entry) => entry.id)).toEqual([
      "auth-telemetry",
      "next-cookies",
    ]);
  });

  test("sign-in codes: six digits, encrypted, reused on resend, valid for the email's TTL", () => {
    expect(plugin("email-otp").options).toMatchObject({
      otpLength: 6,
      expiresIn: SIGN_IN_CODE_TTL_SECONDS,
      allowedAttempts: 5,
      storeOTP: "encrypted",
      resendStrategy: "reuse",
      overrideDefaultEmailVerification: true,
    });
    expect(plugin("email-otp").options.disableSignUp).toBeUndefined();
  });

  test("organizations are created by the server only, with one Principal team each", async () => {
    const { createPrincipalTeam, hierarchyHooks } = await import("./organizations");
    expect(plugin("organization").options).toMatchObject({
      creatorRole: "owner",
      allowUserToCreateOrganization: false,
      teams: {
        enabled: true,
        maximumTeams: 1,
        allowRemovingAllTeams: false,
        defaultTeam: { enabled: true, customCreateDefaultTeam: createPrincipalTeam },
      },
      organizationHooks: hierarchyHooks,
    });
  });

  test("Turnstile guards every path that can send an email", () => {
    expect(plugin("captcha").options).toMatchObject({
      provider: "cloudflare-turnstile",
      secretKey: "turnstile-secret",
      endpoints: [
        "/email-otp/send-verification-otp",
        "/email-otp/request-password-reset",
        "/forget-password/email-otp",
        "/email-otp/request-email-change",
        "/send-verification-email",
      ],
    });
  });

  // The domain check fails before any database work, so this runs without one.
  test("the send guard runs before a sign-in code is created", async () => {
    await expect(
      auth.api.sendVerificationOTP({ body: { email: "ana@mailinator.com", type: "sign-in" } }),
    ).rejects.toMatchObject({ statusCode: 400, body: { reason: "disposable" } });
    expect(email.sendAuthEmail).not.toHaveBeenCalled();
  });

  test("Google needs a verified email and links to the existing user", () => {
    expect(auth.options.socialProviders?.google).toMatchObject({
      clientId: "google-client-id.apps.googleusercontent.com",
      prompt: "select_account",
      requireEmailVerification: true,
    });
    expect(auth.options.account).toMatchObject({
      accountLinking: { enabled: true, trustedProviders: ["google"] },
      encryptOAuthTokens: true,
    });
  });

  test("user fields written by the server only", () => {
    const fields = auth.options.user?.additionalFields ?? {};
    expect(Object.keys(fields).sort()).toEqual([
      "dataPolicyAcceptedAt",
      "dataPolicyVersion",
      "locale",
    ]);
    for (const field of Object.values(fields)) expect(field.input).toBe(false);
  });
});

type Sender = (
  data: {
    email: string;
    otp: string;
    type: "sign-in" | "email-verification" | "forget-password" | "change-email";
  },
  ctx?: unknown,
) => Promise<void>;

function fakeContext({
  headers = {},
  user = null,
  lookup,
}: {
  headers?: Record<string, string>;
  user?: Record<string, unknown> | null;
  lookup?: () => Promise<unknown>;
}) {
  const findUserByEmail = vi.fn(lookup ?? (async () => (user ? { user, accounts: [] } : null)));
  const warn = vi.fn();
  return {
    ctx: {
      headers: new Headers(headers),
      context: { internalAdapter: { findUserByEmail }, logger: { warn } },
    },
    findUserByEmail,
    warn,
  };
}

describe("sending the sign-in code", () => {
  const send = () => plugin("email-otp").options.sendVerificationOTP as Sender;
  const data = { email: "ana@example.co", otp: "482913", type: "sign-in" } as const;
  const anAttempt = { attempt: expect.stringMatching(/^[0-9a-f-]{36}$/) };

  test("every resend is its own attempt, so the reused code is emailed again", async () => {
    email.sendAuthEmail.mockResolvedValue({ id: "email-1" });
    const { ctx } = fakeContext({});
    await send()(data, ctx);
    await send()(data, ctx);
    const [first, second] = email.sendAuthEmail.mock.calls.map((call) => call[3]);
    expect(first).toEqual(anAttempt);
    expect(second).toEqual(anAttempt);
    expect(second).not.toEqual(first);
  });

  test("uses the saved locale and the place the request came from", async () => {
    email.sendAuthEmail.mockResolvedValue({ id: "email-1" });
    const { ctx, findUserByEmail } = fakeContext({
      user: { email: "ana@example.co", locale: "es-CO" },
      headers: { "x-vercel-ip-city": "Bogot%C3%A1", "x-vercel-ip-country": "CO" },
    });
    await send()(data, ctx);
    expect(findUserByEmail).toHaveBeenCalledWith("ana@example.co");
    expect(email.sendAuthEmail).toHaveBeenCalledWith(
      "sign-in-code",
      "ana@example.co",
      {
        otp: "482913",
        locale: "es-CO",
        requestedFrom: { city: "Bogotá", country: "Colombia" },
      },
      anAttempt,
    );
  });

  test("a new address falls back to Accept-Language", async () => {
    email.sendAuthEmail.mockResolvedValue({ id: "email-1" });
    const { ctx } = fakeContext({ headers: { "accept-language": "es-MX,es;q=0.9" } });
    await send()(data, ctx);
    expect(email.sendAuthEmail).toHaveBeenCalledWith(
      "sign-in-code",
      "ana@example.co",
      {
        otp: "482913",
        locale: "es-CO",
      },
      anAttempt,
    );
  });

  test.each([
    ["only the city", { "x-vercel-ip-city": "Cali" }],
    ["only the country", { "x-vercel-ip-country": "CO" }],
    ["an unassigned country", { "x-vercel-ip-city": "Cali", "x-vercel-ip-country": "XX" }],
    ["a malformed country", { "x-vercel-ip-city": "Cali", "x-vercel-ip-country": "T1" }],
    ["a malformed city", { "x-vercel-ip-city": "%E0%A4%A", "x-vercel-ip-country": "CO" }],
  ])("omits the place with %s", async (_, headers) => {
    email.sendAuthEmail.mockResolvedValue({ id: "email-1" });
    const { ctx } = fakeContext({ headers });
    await send()(data, ctx);
    expect(email.sendAuthEmail.mock.calls[0]?.[2]).not.toHaveProperty("requestedFrom");
  });

  test("a failed user lookup still sends the code, and is logged", async () => {
    email.sendAuthEmail.mockResolvedValue({ id: "email-1" });
    // Drizzle puts the query parameters, the address among them, in its error message.
    const failure = new TypeError("Failed query: select … params: ana@example.co");
    const { ctx, warn } = fakeContext({ lookup: () => Promise.reject(failure) });
    await send()(data, ctx);
    expect(email.sendAuthEmail).toHaveBeenCalledWith(
      "sign-in-code",
      "ana@example.co",
      {
        otp: "482913",
        locale: "es-CO",
      },
      anAttempt,
    );
    expect(warn).toHaveBeenCalledWith(expect.any(String), "TypeError");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("ana@example.co");
  });

  test.each(["email-verification", "forget-password", "change-email"] as const)(
    "never sends a %s code: V0 signs in with codes only",
    async (type) => {
      const { ctx, warn, findUserByEmail } = fakeContext({});
      await send()({ ...data, type }, ctx);
      expect(email.sendAuthEmail).not.toHaveBeenCalled();
      expect(findUserByEmail).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.any(String), type);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("ana@example.co");
    },
  );

  test("works without an endpoint context", async () => {
    email.sendAuthEmail.mockResolvedValue({ id: "email-1" });
    await send()(data);
    expect(email.sendAuthEmail).toHaveBeenCalledWith(
      "sign-in-code",
      "ana@example.co",
      {
        otp: "482913",
        locale: "es-CO",
      },
      anAttempt,
    );
  });

  test("a failed send rejects so Better Auth's background handler logs it", async () => {
    const failure = new Error("resend down");
    email.sendAuthEmail.mockRejectedValue(failure);
    const { ctx } = fakeContext({});
    await expect(send()(data, ctx)).rejects.toBe(failure);
  });
});
