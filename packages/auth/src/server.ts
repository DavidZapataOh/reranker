import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { toDbError } from "@reranker/db";
import { authDb } from "@reranker/db/auth-adapter";
import * as authTables from "@reranker/db/schema/auth";
import { defineEnv } from "@reranker/env";
import { DEFAULT_LOCALE, type Locale } from "@reranker/i18n";
import { ERRORS, isAppError } from "@reranker/schema";
import { waitUntil } from "@vercel/functions";
import { betterAuth, type GenericEndpointContext } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { captcha, emailOTP, oneTap, organization } from "better-auth/plugins";
import { COOKIE_PREFIX } from "./cookies";
import { resolveEmailLocale } from "./email-locale";
import type { RequestedFrom } from "./emails/sign-in-code";
import { authEnv } from "./env";
import { createPrincipalTeam, hierarchyHooks, MEMBER_FIELDS, ORG_FIELDS } from "./organizations";
import { authOrigins } from "./origins";
import { ac, roles } from "./permissions";
import { rateLimitStorage } from "./rate-limit-storage";
import { AUTH_RATE_RULES, EMAIL_SENDING_PATHS } from "./rate-limits";
import { sendAuthEmail } from "./send-auth-email";
import { SIGN_IN_CODE_TTL_SECONDS } from "./sign-in-code";
import { authTelemetry } from "./telemetry";

const env = defineEnv([authEnv]);

const PASSWORD_PATHS = [
  "/sign-in/email",
  "/sign-up/email",
  "/change-password",
  "/request-password-reset",
  "/reset-password",
  "/verify-password",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/email-otp/reset-password",
];

const { baseURL, trustedOrigins: origins } = authOrigins(env);

// White-label domains join this list in a later version.
export const trustedOrigins: string[] = origins;

// Vercel URL-encodes the city header ("Bogot%C3%A1"); a value that does not decode is dropped
// rather than shown garbled.
function requestedFrom(headers: Headers | undefined, locale: Locale): RequestedFrom | undefined {
  const city = headers?.get("x-vercel-ip-city");
  const countryCode = headers?.get("x-vercel-ip-country");
  if (!city || !countryCode) return undefined;
  try {
    const country = new Intl.DisplayNames([locale], { type: "region", fallback: "none" }).of(
      countryCode,
    );
    return country ? { city: decodeURIComponent(city), country } : undefined;
  } catch {
    return undefined;
  }
}

// The code matters more than its language: a failed lookup falls back to the request's.
async function savedLocale(
  ctx: GenericEndpointContext,
  email: string,
): Promise<string | undefined> {
  try {
    const found = await ctx.context.internalAdapter.findUserByEmail(email);
    return (found?.user as { locale?: string | null } | undefined)?.locale ?? undefined;
  } catch (error) {
    // Drizzle errors carry the query parameters, the address among them, so only the class is logged.
    ctx.context.logger.warn(
      "Sign-in code sent without the saved locale",
      error instanceof Error ? error.name : "unknown",
    );
    return undefined;
  }
}

// Runs in the background through runInBackgroundOrAwait, whose handler logs a rejection; a
// failed Resend call also emits auth_email_failed inside sendAuthEmail.
// The plugin calls this for password reset, email change and core email verification too. V0 has
// none of them (new users come out of /sign-in/email-otp already verified), so only sign-in sends.
async function sendSignInCode(
  { email, otp, type }: { email: string; otp: string; type: string },
  ctx?: GenericEndpointContext,
): Promise<void> {
  if (type !== "sign-in") {
    ctx?.context.logger.warn("Email code not sent for an unsupported flow", type);
    return;
  }
  // Better Auth calls this once per send request, so a resend of the reused code is a new attempt
  // and a new email; anything retrying this send keeps the same attempt.
  const attempt = crypto.randomUUID();
  const locale = resolveEmailLocale({
    userLocale: ctx ? await savedLocale(ctx, email) : undefined,
    acceptLanguage: ctx?.headers?.get("accept-language"),
  });
  const place = requestedFrom(ctx?.headers, locale);
  await sendAuthEmail(
    "sign-in-code",
    email,
    { otp, locale, ...(place ? { requestedFrom: place } : {}) },
    { attempt },
  );
}

export const auth = betterAuth({
  appName: "Reranker",
  baseURL,
  // Better Auth reads the rotation list from BETTER_AUTH_SECRETS itself; authEnv validates it.
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins,
  // Better Auth mounts the password routes whatever the config says; with no password sign-in
  // they only widen the surface.
  disabledPaths: PASSWORD_PATHS,
  database: drizzleAdapter(authDb, {
    provider: "pg",
    schema: authTables,
    usePlural: true,
    schemaName: "auth",
  }),
  // Errors that are not an APIError reach handleAuthRequest, which answers a busy database with a
  // 503 instead of Better Auth's bare 500.
  onAPIError: { throw: true },
  advanced: {
    database: { generateId: "uuid", joins: true },
    cookiePrefix: COOKIE_PREFIX,
    ipAddress: { ipAddressHeaders: ["x-real-ip", "x-forwarded-for"] },
    backgroundTasks: { handler: waitUntil },
  },
  socialProviders: {
    google: {
      clientId: env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      prompt: "select_account",
      // Incremental authorization would fold any earlier grant into the token; sign-in needs none.
      includeGrantedScopes: false,
      requireEmailVerification: true,
    },
  },
  account: {
    accountLinking: { enabled: true, trustedProviders: ["google"] },
    encryptOAuthTokens: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    freshAge: 60 * 60,
    cookieCache: { enabled: true, maxAge: 300, strategy: "compact" },
  },
  user: {
    // A trusted provider links to the user with the same address without checking that the
    // provider verified it, so Google's email_verified claim is enforced here instead.
    validateUserInfo: ({ user, source }) => {
      if (source.oauth?.providerId === "google" && user.emailVerified !== true) {
        return {
          error: "email_not_verified",
          errorDescription: "Google no ha verificado este correo",
        };
      }
    },
    additionalFields: {
      locale: { type: "string", required: false, defaultValue: DEFAULT_LOCALE, input: false },
      dataPolicyVersion: { type: "string", required: false, input: false },
      dataPolicyAcceptedAt: { type: "date", required: false, input: false },
    },
  },
  hooks: {
    // Loaded on the first send: session reads, most of the traffic, never need the quota code.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/email-otp/send-verification-otp") return;
      const { guardOtpSend } = await import("./guard-otp-send");
      await guardOtpSend(ctx);
    }),
  },
  rateLimit: {
    enabled: true,
    // customStorage decides every request; "database" keeps auth.rate_limits in the generated
    // schema, where the storage writes and the purge reads.
    storage: "database",
    customStorage: rateLimitStorage,
    window: 60,
    max: 100,
    customRules: AUTH_RATE_RULES,
  },
  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: SIGN_IN_CODE_TTL_SECONDS,
      allowedAttempts: 5,
      storeOTP: "encrypted",
      resendStrategy: "reuse",
      overrideDefaultEmailVerification: true,
      sendVerificationOTP: sendSignInCode,
    }),
    organization({
      ac,
      roles,
      creatorRole: "owner",
      allowUserToCreateOrganization: false,
      // Deleting the house would take every anonymous report and lead with it; off until a guard
      // can refuse that.
      disableOrganizationDeletion: true,
      teams: {
        enabled: true,
        maximumTeams: 1,
        allowRemovingAllTeams: false,
        defaultTeam: { enabled: true, customCreateDefaultTeam: createPrincipalTeam },
      },
      organizationHooks: hierarchyHooks,
      schema: {
        organization: { additionalFields: ORG_FIELDS },
        member: { additionalFields: MEMBER_FIELDS },
      },
    }),
    captcha({
      provider: "cloudflare-turnstile",
      secretKey: env.TURNSTILE_SECRET_KEY,
      endpoints: EMAIL_SENDING_PATHS,
    }),
    // Takes the client id from the Google provider, and its sign-ins pass validateUserInfo too.
    oneTap(),
    authTelemetry(),
    nextCookies(),
  ],
});

/**
 * Better Auth's HTTP handler. The rate limiter runs before Better Auth catches anything, so a
 * database that cannot answer in time (a pool still full past its checkout timeout, a dropped
 * connection) would leave as a raw exception; it answers 503 with the wait instead, in the shape
 * guardOtpSend uses. Any other failure is a bug and propagates.
 */
export async function handleAuthRequest(request: Request): Promise<Response> {
  try {
    return await auth.handler(request);
  } catch (error) {
    const translated = toDbError(error, { pool: "system" });
    if (!isAppError(translated) || !translated.retryable) throw error;
    const definition: { status: number; retryAfterSeconds?: number } = ERRORS[translated.code];
    const wait = String(translated.retryAfterSeconds ?? definition.retryAfterSeconds ?? 1);
    return Response.json(
      { code: "SERVICE_UNAVAILABLE", message: "Service unavailable: retry", reason: "unavailable" },
      { status: 503, headers: { "Retry-After": wait, "X-Retry-After": wait } },
    );
  }
}
