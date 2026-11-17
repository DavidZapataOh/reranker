import { endPools, withSystem } from "@reranker/db";
import { users } from "@reranker/db/schema/auth";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, test, vi } from "vitest";
import { readSignInCode } from "../test/sign-in-code";

// Nothing has to reach an inbox: the code is read from the database.
vi.mock("./send-auth-email", () => ({ sendAuthEmail: vi.fn() }));

const secret = () => `${crypto.randomUUID()}${crypto.randomUUID()}`;
vi.stubEnv("APP_ENV", "development");
vi.stubEnv("BETTER_AUTH_SECRET", secret());
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
vi.stubEnv("RESEND_API_KEY", "re_test");
vi.stubEnv("TURNSTILE_SECRET_KEY", "turnstile-secret");
vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "turnstile-site");
vi.stubEnv("CAPACITY_HMAC_KEY", secret());

const { auth } = await import("./server");
type Auth = typeof auth;

const emails: string[] = [];

afterAll(async () => {
  await withSystem("test.cleanup", (tx) => tx.delete(users).where(inArray(users.email, emails)));
  await endPools();
});

// The send guard limits codes per address and network, so each sign-in comes from its own /24.
const nextIp = () => {
  const octet = () => Math.floor(Math.random() * 256);
  return `10.${octet()}.${octet()}.${1 + Math.floor(Math.random() * 254)}`;
};

async function signIn(instance: Auth, email: string): Promise<string[]> {
  emails.push(email);
  await instance.api.sendVerificationOTP({
    body: { email, type: "sign-in" },
    headers: new Headers({ "x-real-ip": nextIp() }),
  });
  const otp = await readSignInCode(email);
  const { headers } = await instance.api.signInEmailOTP({
    body: { email, otp },
    returnHeaders: true,
  });
  return headers.getSetCookie();
}

const sessionCookie = (setCookies: string[], name: string) =>
  setCookies.find((cookie) => cookie.startsWith(`${name}=`));

const cookieHeader = (setCookies: string[]) =>
  setCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");

describe("session over http://localhost", () => {
  test("a sign-in code yields a session that get-session returns", async () => {
    const email = "delivered+session@resend.dev";
    const setCookies = await signIn(auth, email);

    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { cookie: cookieHeader(setCookies) },
      }),
    );
    expect(response.status).toBe(200);
    const session = (await response.json()) as { user: { email: string } } | null;
    expect(session?.user.email).toBe(email);
  });

  test("get-session without a cookie returns null", async () => {
    const response = await auth.handler(new Request("http://localhost:3000/api/auth/get-session"));
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  test("the session cookie is HttpOnly, SameSite=Lax and scoped to the whole site", async () => {
    const cookie = sessionCookie(
      await signIn(auth, "delivered+session-attributes@resend.dev"),
      "rr.session_token",
    );
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).toMatch(/; Path=\/(;|$)/);
    expect(cookie).not.toMatch(/; Secure/i);
  });

  // Off until they can refuse to delete the house or its last owner.
  test.each([
    ["/delete-user", {}],
    ["/organization/delete", { organizationId: crypto.randomUUID() }],
  ])("%s is not reachable with a session", async (path, body) => {
    const setCookies = await signIn(auth, `delivered+session-delete-${path.length}@resend.dev`);
    const response = await auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: {
          cookie: cookieHeader(setCookies),
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(404);
  });
});

// A fresh module graph builds a second instance from the https origin; its pools close here.
test("over https the session cookie is Secure with the __Secure- prefix", async () => {
  vi.resetModules();
  vi.stubEnv("BETTER_AUTH_URL", "https://reranker.co");
  const [{ auth: secureAuth }, secureDb] = await Promise.all([
    import("./server"),
    import("@reranker/db"),
  ]);
  let cookie: string | undefined;
  try {
    cookie = sessionCookie(
      await signIn(secureAuth, "delivered+session-secure@resend.dev"),
      "__Secure-rr.session_token",
    );
  } finally {
    await secureDb.endPools();
  }
  expect(cookie).toMatch(/; Secure/i);
  expect(cookie).toMatch(/; HttpOnly/i);
  expect(cookie).toMatch(/; SameSite=Lax/i);
});
