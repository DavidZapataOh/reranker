import { endPools, withSystem } from "@reranker/db";
import { accounts, users } from "@reranker/db/schema/auth";
import { server } from "@reranker/testing/msw";
import { eq, inArray } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { readSignInCode } from "../test/sign-in-code";

// Nothing has to reach an inbox: the code is read from the database.
vi.mock("./send-auth-email", () => ({ sendAuthEmail: vi.fn() }));

const CLIENT_ID = "google-client-id.apps.googleusercontent.com";
const secret = () => `${crypto.randomUUID()}${crypto.randomUUID()}`;
vi.stubEnv("APP_ENV", "development");
vi.stubEnv("BETTER_AUTH_SECRET", secret());
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", CLIENT_ID);
vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
vi.stubEnv("RESEND_API_KEY", "re_test");
vi.stubEnv("TURNSTILE_SECRET_KEY", "turnstile-secret");
vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "turnstile-site");
vi.stubEnv("CAPACITY_HMAC_KEY", secret());

const { auth } = await import("./server");

const ORIGIN = "http://localhost:3000";
const emails: string[] = [];

// Google's signing key for this run: One Tap verifies the ID token's signature against the JWKS
// Google publishes, so the stand-in Google signs for real and serves the public half.
const KEY_ID = "test-google-key";
const googleKey = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const publicJwk = await crypto.subtle.exportKey("jwk", googleKey.publicKey);

beforeAll(() => {
  server.listen();
});
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await withSystem("test.cleanup", (tx) => tx.delete(users).where(inArray(users.email, emails)));
  await endPools();
});

// The send guard limits codes per address and network, so each request comes from its own /24.
const nextIp = () => {
  const octet = () => Math.floor(Math.random() * 256);
  return `10.${octet()}.${octet()}.${1 + Math.floor(Math.random() * 254)}`;
};

const cookieHeader = (setCookies: string[]) =>
  setCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");

const hasSession = (response: Response) =>
  response.headers.getSetCookie().some((cookie) => cookie.startsWith("rr.session_token="));

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

type GoogleClaims = { sub: string; email: string; email_verified: boolean };

async function googleIdToken(claims: GoogleClaims): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    base64url({ alg: "RS256", kid: KEY_ID, typ: "JWT" }),
    base64url({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      azp: CLIENT_ID,
      iat: now,
      exp: now + 3600,
      name: "Ana Pérez",
      ...claims,
    }),
  ].join(".");
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    googleKey.privateKey,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
}

/** Google answers the code exchange with an ID token for this identity, as its token endpoint does. */
async function googleSignsIn(claims: GoogleClaims): Promise<void> {
  const idToken = await googleIdToken(claims);
  server.use(
    http.post("https://oauth2.googleapis.com/token", () =>
      HttpResponse.json({
        access_token: "access-token",
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 3599,
        scope: "openid https://www.googleapis.com/auth/userinfo.email",
      }),
    ),
  );
}

async function signInWithCode(email: string): Promise<string> {
  await auth.api.sendVerificationOTP({
    body: { email, type: "sign-in" },
    headers: new Headers({ "x-real-ip": nextIp() }),
  });
  const otp = await readSignInCode(email);
  const { user } = await auth.api.signInEmailOTP({ body: { email, otp } });
  return user.id;
}

/** The browser's side of "Continuar con Google": start, then come back from Google with a code. */
async function continueWithGoogle(): Promise<Response> {
  const start = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-real-ip": nextIp() },
      body: JSON.stringify({ provider: "google", callbackURL: "/app" }),
    }),
  );
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorization = new URL(url);
  expect(authorization.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/google`);
  const state = authorization.searchParams.get("state");
  if (!state) throw new Error("the authorization URL carries no state");
  return auth.handler(
    new Request(`${ORIGIN}/api/auth/callback/google?code=code&state=${state}`, {
      headers: { cookie: cookieHeader(start.headers.getSetCookie()) },
    }),
  );
}

/** What the One Tap prompt posts once the person taps their Google account. */
async function tapGoogleAccount(claims: GoogleClaims): Promise<Response> {
  server.use(
    http.get("https://www.googleapis.com/oauth2/v3/certs", () =>
      HttpResponse.json({ keys: [{ ...publicJwk, kid: KEY_ID, alg: "RS256", use: "sig" }] }),
    ),
  );
  return auth.handler(
    new Request(`${ORIGIN}/api/auth/one-tap/callback`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-real-ip": nextIp() },
      body: JSON.stringify({ idToken: await googleIdToken(claims) }),
    }),
  );
}

const userAccounts = (userId: string) =>
  withSystem("test.read-accounts", (tx) =>
    tx
      .select({ providerId: accounts.providerId, accountId: accounts.accountId })
      .from(accounts)
      .where(eq(accounts.userId, userId)),
  );

const usersWith = (email: string) =>
  withSystem("test.read-users", (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, email)),
  );

const googleIdentity = (email: string, email_verified = true): GoogleClaims => {
  emails.push(email);
  return { sub: `google-${crypto.randomUUID()}`, email, email_verified };
};

describe("one person, one user, whichever way they come in", () => {
  test("a code first, then Google with the same address: the same user, with Google linked", async () => {
    const google = googleIdentity("delivered+google-after-code@resend.dev");
    const userId = await signInWithCode(google.email);
    await googleSignsIn(google);

    const response = await continueWithGoogle();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app");
    expect(hasSession(response)).toBe(true);
    expect(await usersWith(google.email)).toEqual([{ id: userId }]);
    expect(await userAccounts(userId)).toContainEqual({
      providerId: "google",
      accountId: google.sub,
    });
  });

  test("Google first, then a code to the same address: the same user", async () => {
    const google = googleIdentity("delivered+code-after-google@resend.dev");
    await googleSignsIn(google);
    const response = await continueWithGoogle();
    expect(response.headers.get("location")).toBe("/app");
    const [created] = await usersWith(google.email);
    if (!created) throw new Error("Google sign-in created no user");

    const userId = await signInWithCode(google.email);

    expect(userId).toBe(created.id);
    expect(await usersWith(google.email)).toEqual([{ id: userId }]);
    expect(await userAccounts(userId)).toContainEqual({
      providerId: "google",
      accountId: google.sub,
    });
  });

  test("a code first, then One Tap with the same address: the same user", async () => {
    const google = googleIdentity("delivered+one-tap-after-code@resend.dev");
    const userId = await signInWithCode(google.email);

    const response = await tapGoogleAccount(google);

    expect(response.status).toBe(200);
    expect(hasSession(response)).toBe(true);
    expect(((await response.json()) as { user: { id: string } }).user.id).toBe(userId);
    expect(await usersWith(google.email)).toEqual([{ id: userId }]);
    expect(await userAccounts(userId)).toContainEqual({
      providerId: "google",
      accountId: google.sub,
    });
  });
});

// Linking to Google is automatic, so an address Google has not verified must never reach a user.
describe("an address Google has not verified", () => {
  test("is refused and never linked to the user who signed in with a code", async () => {
    const google = googleIdentity("delivered+google-unverified@resend.dev", false);
    const userId = await signInWithCode(google.email);
    await googleSignsIn(google);

    const response = await continueWithGoogle();

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location") ?? "", ORIGIN).searchParams.get("error")).toBe(
      "email_not_verified",
    );
    expect(hasSession(response)).toBe(false);
    expect((await userAccounts(userId)).map((account) => account.providerId)).not.toContain(
      "google",
    );
  });

  test("creates no user", async () => {
    const google = googleIdentity("delivered+google-new-unverified@resend.dev", false);
    await googleSignsIn(google);

    const response = await continueWithGoogle();

    expect(response.status).toBe(302);
    expect(hasSession(response)).toBe(false);
    expect(await usersWith(google.email)).toEqual([]);
  });

  test("is refused through One Tap too", async () => {
    const google = googleIdentity("delivered+one-tap-unverified@resend.dev", false);
    const userId = await signInWithCode(google.email);

    const response = await tapGoogleAccount(google);

    expect(response.status).toBe(403);
    expect(hasSession(response)).toBe(false);
    expect((await userAccounts(userId)).map((account) => account.providerId)).not.toContain(
      "google",
    );
  });
});
