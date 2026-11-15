import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { authDb } from "@reranker/db/auth-adapter";
import * as authTables from "@reranker/db/schema/auth";
import { defineEnv } from "@reranker/env";
import { DEFAULT_LOCALE, type Locale } from "@reranker/i18n";
import { waitUntil } from "@vercel/functions";
import { betterAuth, type GenericEndpointContext } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { captcha, emailOTP, organization } from "better-auth/plugins";
import { resolveEmailLocale } from "./email-locale";
import type { RequestedFrom } from "./emails/sign-in-code";
import { authEnv } from "./env";
import { MEMBER_FIELDS, ORG_FIELDS } from "./organizations";
import { ac, roles } from "./permissions";
import { AUTH_RATE_RULES } from "./rate-limits";
import { sendAuthEmail } from "./send-auth-email";
import { SIGN_IN_CODE_TTL_SECONDS } from "./sign-in-code";

const env = defineEnv([authEnv]);

// White-label domains join this list in a later version.
export const trustedOrigins: string[] = [env.BETTER_AUTH_URL];

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
    ctx.context.logger.warn("Sign-in code sent without the saved locale", error);
    return undefined;
  }
}

// Runs in the background through runInBackgroundOrAwait, whose handler logs a rejection; a
// failed Resend call also emits auth_email_failed inside sendAuthEmail.
async function sendSignInCode(
  { email, otp }: { email: string; otp: string },
  ctx?: GenericEndpointContext,
): Promise<void> {
  const locale = resolveEmailLocale({
    userLocale: ctx ? await savedLocale(ctx, email) : undefined,
    acceptLanguage: ctx?.headers?.get("accept-language"),
  });
  const place = requestedFrom(ctx?.headers, locale);
  await sendAuthEmail("sign-in-code", email, {
    otp,
    locale,
    ...(place ? { requestedFrom: place } : {}),
  });
}

export const auth = betterAuth({
  appName: "Reranker",
  baseURL: env.BETTER_AUTH_URL,
  // Better Auth reads the rotation list from BETTER_AUTH_SECRETS itself; authEnv validates it.
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins,
  database: drizzleAdapter(authDb, {
    provider: "pg",
    schema: authTables,
    usePlural: true,
    schemaName: "auth",
  }),
  advanced: {
    database: { generateId: "uuid", joins: true },
    cookiePrefix: "rr",
    ipAddress: { ipAddressHeaders: ["x-real-ip", "x-forwarded-for"] },
    backgroundTasks: { handler: waitUntil },
  },
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      prompt: "select_account",
      requireEmailVerification: true,
    },
  },
  account: { accountLinking: { enabled: true, trustedProviders: ["google"] } },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    freshAge: 60 * 60,
    cookieCache: { enabled: true, maxAge: 300, strategy: "compact" },
  },
  user: {
    additionalFields: {
      locale: { type: "string", required: false, defaultValue: DEFAULT_LOCALE, input: false },
      dataPolicyVersion: { type: "string", required: false, input: false },
      dataPolicyAcceptedAt: { type: "date", required: false, input: false },
    },
    deleteUser: { enabled: true },
  },
  rateLimit: {
    enabled: true,
    storage: "database",
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
      teams: {
        enabled: true,
        maximumTeams: 1,
        allowRemovingAllTeams: false,
        defaultTeam: { enabled: true },
      },
      schema: {
        organization: { additionalFields: ORG_FIELDS },
        member: { additionalFields: MEMBER_FIELDS },
      },
    }),
    captcha({
      provider: "cloudflare-turnstile",
      secretKey: env.TURNSTILE_SECRET_KEY,
      endpoints: ["/email-otp/send-verification-otp"],
    }),
    nextCookies(),
  ],
});
