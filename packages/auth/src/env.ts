import { config, forbiddenIn, onlyIn, requiredIn, secret } from "@reranker/env";
import { z } from "@reranker/schema";

const httpsUrl = z.url({ protocol: /^https$/ });
const localhostUrl = z.string().regex(/^http:\/\/localhost(:\d+)?$/);
const vercelHost = z.string().regex(/^[a-z0-9-]+\.vercel\.app$/);

// "2:new,1:old": Better Auth encrypts with the first version and decrypts with every listed one.
const rotationSecrets = z
  .string()
  .regex(/^\d+:[^,\s]+(,\d+:[^,\s]+)*$/, "must be version:secret pairs");

// Cloudflare's published testing keys answer the same way for every visitor, so they never reach
// production: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const TURNSTILE_TESTING_SECRETS = [
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
] as const;
const TURNSTILE_TESTING_SITE_KEYS = [
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "1x00000000000000000000BB",
  "2x00000000000000000000BB",
  "3x00000000000000000000FF",
] as const;

function turnstileKey(testing: readonly [string, ...string[]]) {
  const real = z
    .string()
    .min(1)
    .refine((key) => !testing.includes(key));
  return z.union([real, onlyIn(["development", "preview"], z.enum(testing))]);
}

export const authEnv = z.object({
  BETTER_AUTH_SECRET: secret(
    z.string().min(32),
    "Better Auth signing and encryption secret, at least 32 characters",
  ),
  BETTER_AUTH_SECRETS: secret(
    rotationSecrets.optional(),
    "Versioned secrets for rotation, newest first, as 2:new,1:old",
  ),
  // Each preview deployment has its own URLs, so preview reads them from Vercel instead.
  BETTER_AUTH_URL: requiredIn(
    ["development", "production"],
    forbiddenIn(
      ["preview"],
      config(
        z.union([httpsUrl, onlyIn(["development"], localhostUrl)]),
        "Public origin of the app in development and production; http://localhost is accepted in development only",
      ),
    ),
  ),
  VERCEL_URL: requiredIn(
    ["preview"],
    config(vercelHost, "Deployment hostname, set by Vercel; the auth origin of a preview"),
  ),
  VERCEL_BRANCH_URL: config(
    vercelHost.optional(),
    "Branch hostname, set by Vercel on Git deployments; also served by a preview",
  ),
  // Public by design: the browser needs it for One Tap and Google shows it in every sign-in URL.
  NEXT_PUBLIC_GOOGLE_CLIENT_ID: config(
    z.string().regex(/^[\w-]+\.apps\.googleusercontent\.com$/, "must be a Google web client id"),
    "Google OAuth web client id, shared by the server and One Tap in the browser",
  ),
  GOOGLE_CLIENT_SECRET: secret(z.string().min(1), "Google OAuth client secret"),
  RESEND_API_KEY: secret(z.string().startsWith("re_"), "Resend API key for sign-in codes"),
  TURNSTILE_SECRET_KEY: secret(
    turnstileKey(TURNSTILE_TESTING_SECRETS),
    "Cloudflare Turnstile secret key; testing keys are refused in production",
  ),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: config(
    turnstileKey(TURNSTILE_TESTING_SITE_KEYS),
    "Cloudflare Turnstile site key for the browser; testing keys are refused in production",
  ),
  CAPACITY_HMAC_KEY: secret(
    z.string().min(32),
    "HMAC key for the email and IP capacity bucket keys, at least 32 characters",
  ),
});
