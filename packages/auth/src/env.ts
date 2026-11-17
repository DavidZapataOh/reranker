import { config, forbiddenIn, onlyIn, requiredIn, secret } from "@reranker/env";
import { z } from "@reranker/schema";

const httpsUrl = z.url({ protocol: /^https$/ });
const localhostUrl = z.string().regex(/^http:\/\/localhost(:\d+)?$/);
const vercelHost = z.string().regex(/^[a-z0-9-]+\.vercel\.app$/);

// "2:new,1:old": Better Auth encrypts with the first version and decrypts with every listed one.
const rotationSecrets = z
  .string()
  .regex(/^\d+:[^,\s]+(,\d+:[^,\s]+)*$/, "must be version:secret pairs");

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
  GOOGLE_CLIENT_ID: config(z.string().min(1), "Google OAuth client id"),
  GOOGLE_CLIENT_SECRET: secret(z.string().min(1), "Google OAuth client secret"),
  RESEND_API_KEY: secret(z.string().startsWith("re_"), "Resend API key for sign-in codes"),
  TURNSTILE_SECRET_KEY: secret(z.string().min(1), "Cloudflare Turnstile secret key"),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: config(
    z.string().min(1),
    "Cloudflare Turnstile site key for the browser",
  ),
  CAPACITY_HMAC_KEY: secret(
    z.string().min(32),
    "HMAC key for the email and IP capacity bucket keys, at least 32 characters",
  ),
});
