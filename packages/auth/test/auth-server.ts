import { vi } from "vitest";
import { readSignInCode } from "./sign-in-code";

export const ORIGIN = "http://localhost:3000";

const secret = () => `${crypto.randomUUID()}${crypto.randomUUID()}`;

/** The environment the auth server validates on import; call it before importing `src/server`. */
export function stubAuthEnv(): void {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("BETTER_AUTH_SECRET", secret());
  vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "google-client-id.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "turnstile-secret");
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "turnstile-site");
  vi.stubEnv("CAPACITY_HMAC_KEY", secret());
}

// The send guard limits codes per address and network, so each sign-in comes from its own /24.
export const nextIp = () => {
  const octet = () => Math.floor(Math.random() * 256);
  return `10.${octet()}.${octet()}.${1 + Math.floor(Math.random() * 254)}`;
};

type SignInApi = {
  api: {
    sendVerificationOTP(input: {
      body: { email: string; type: "sign-in" };
      headers: Headers;
    }): Promise<unknown>;
    signInEmailOTP(input: {
      body: { email: string; otp: string };
      returnHeaders: true;
    }): Promise<{ headers: Headers; response: { user: { id: string } } }>;
  };
};

/** Signs in with a code read from the database; returns the user id and a request cookie header. */
export async function signInWithCode(
  auth: SignInApi,
  email: string,
): Promise<{ userId: string; cookie: string }> {
  await auth.api.sendVerificationOTP({
    body: { email, type: "sign-in" },
    headers: new Headers({ "x-real-ip": nextIp() }),
  });
  const otp = await readSignInCode(email);
  const { headers, response } = await auth.api.signInEmailOTP({
    body: { email, otp },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((entry) => entry.split(";", 1)[0])
    .join("; ");
  return { userId: response.user.id, cookie };
}
