import { endPools, withSystem } from "@reranker/db";
import { users, verifications } from "@reranker/db/schema/auth";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { readSignInCode } from "../test/sign-in-code";

// Nothing has to reach an inbox: the code is read from the database.
const mail = vi.hoisted(() => ({ sendAuthEmail: vi.fn() }));
vi.mock("./send-auth-email", () => mail);

const secret = () => `${crypto.randomUUID()}${crypto.randomUUID()}`;
vi.stubEnv("APP_ENV", "development");
vi.stubEnv("BETTER_AUTH_SECRET", secret());
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "google-client-id.apps.googleusercontent.com");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
vi.stubEnv("RESEND_API_KEY", "re_test");
// Cloudflare's always-passes testing secret and the dummy token its testing site keys issue.
vi.stubEnv("TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA");
vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
vi.stubEnv("CAPACITY_HMAC_KEY", secret());
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const { auth } = await import("./server");
type Auth = typeof auth;

const emails = new Set<string>();

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  const addresses = [...emails];
  await withSystem("test.cleanup", async (tx) => {
    await tx.delete(users).where(inArray(users.email, addresses));
    await tx.delete(verifications).where(
      inArray(
        verifications.identifier,
        addresses.map((email) => `sign-in-otp-${email}`),
      ),
    );
  });
  await endPools();
});

// A random /24 per call, so no two tests share an address or network bucket.
function nextIp(): string {
  const octet = () => Math.floor(Math.random() * 256);
  return `10.${octet()}.${octet()}.${1 + Math.floor(Math.random() * 254)}`;
}

function post(instance: Auth, path: string, body: unknown, headers: Record<string, string>) {
  return instance.handler(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function sendCode(
  email: string,
  {
    ip,
    captcha = DUMMY_TOKEN,
    instance = auth,
  }: { ip: string; captcha?: string | null; instance?: Auth },
): Promise<Response> {
  emails.add(email.trim().toLowerCase());
  return post(
    instance,
    "/email-otp/send-verification-otp",
    { email, type: "sign-in" },
    { "x-real-ip": ip, ...(captcha === null ? {} : { "x-captcha-response": captcha }) },
  );
}

function signIn(email: string, otp: string, ip: string): Promise<Response> {
  return post(auth, "/sign-in/email-otp", { email, otp }, { "x-real-ip": ip });
}

async function pendingCodes(email: string): Promise<number> {
  const rows = await withSystem("test.read-verifications", (tx) =>
    tx
      .select({ id: verifications.id })
      .from(verifications)
      .where(eq(verifications.identifier, `sign-in-otp-${email.toLowerCase()}`)),
  );
  return rows.length;
}

// Codes emailed to one address. Sends run in the background and can land after the test that
// made them, so assertions look at their own address only.
const sentTo = (email: string) =>
  mail.sendAuthEmail.mock.calls
    .filter(([, to]) => to === email)
    .map(([, , data]) => (data as { otp: string }).otp);

// Resend sends one email per idempotency key, so each send has to be its own attempt to arrive.
const attemptsTo = (email: string) =>
  mail.sendAuthEmail.mock.calls
    .filter(([, to]) => to === email)
    .map(([, , , options]) => (options as { attempt: string }).attempt);

const wrongCode = (otp: string) => String((Number(otp) + 1) % 1_000_000).padStart(6, "0");

describe("sending a sign-in code", () => {
  test("fourth send from the same IP within 600 s is 429 with X-Retry-After", async () => {
    const ip = nextIp();
    for (const i of [1, 2, 3]) {
      expect((await sendCode(`delivered+rl${i}@resend.dev`, { ip })).status).toBe(200);
    }
    const fourth = await sendCode("delivered+rl4@resend.dev", { ip });
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers.get("X-Retry-After"))).toBeGreaterThan(0);
  });

  test("send without Turnstile token is 400", async () => {
    const response = await sendCode("delivered+nt@resend.dev", { ip: nextIp(), captcha: null });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "MISSING_RESPONSE" });
    expect(await pendingCodes("delivered+nt@resend.dev")).toBe(0);
  });

  test("ten concurrent sends from one IP: exactly 3 pass, 7 are 429, no 5xx", async () => {
    const ip = nextIp();
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => sendCode(`delivered+burst${i}@resend.dev`, { ip })),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(3);
    expect(statuses.filter((status) => status === 429)).toHaveLength(7);
  });

  test("guard rejection (disposable domain) is returned before sending", async () => {
    const email = "ana.disposable@mailinator.com";
    const response = await sendCode(email, { ip: nextIp() });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ reason: "disposable" });
    expect(await pendingCodes(email)).toBe(0);
    expect(sentTo(email)).toEqual([]);
  });

  test("fourth code for the same normalized email within an hour is rejected with rate_limited", async () => {
    for (const email of ["a.na+1@gmail.com", "ana+2@gmail.com", "an.a@gmail.com"]) {
      expect((await sendCode(email, { ip: nextIp() })).status).toBe(200);
    }
    const fourth = await sendCode("ana@gmail.com", { ip: nextIp() });
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toMatchObject({ reason: "rate_limited" });
    expect(Number(fourth.headers.get("X-Retry-After"))).toBeGreaterThan(0);
    expect(await pendingCodes("ana@gmail.com")).toBe(0);
  });
});

describe("signing in with a code", () => {
  test("expired code → OTP_EXPIRED, same body shape for known and unknown emails", async () => {
    const known = "delivered+expired-known@resend.dev";
    const unknown = "delivered+expired-unknown@resend.dev";
    expect((await sendCode(known, { ip: nextIp() })).status).toBe(200);
    expect((await signIn(known, await readSignInCode(known), nextIp())).status).toBe(200);

    const bodies: unknown[] = [];
    for (const email of [known, unknown]) {
      expect((await sendCode(email, { ip: nextIp() })).status).toBe(200);
      const otp = await readSignInCode(email);
      await withSystem("test.expire-code", (tx) =>
        tx
          .update(verifications)
          .set({ expiresAt: sql`now() - interval '1 second'` })
          .where(eq(verifications.identifier, `sign-in-otp-${email}`)),
      );
      const response = await signIn(email, otp, nextIp());
      expect(response.status).toBe(400);
      bodies.push(await response.json());
    }
    expect(bodies[0]).toMatchObject({ code: "OTP_EXPIRED" });
    expect(bodies[1]).toEqual(bodies[0]);
  });

  test("sixth wrong attempt → TOO_MANY_ATTEMPTS (403)", async () => {
    const email = "delivered+attempts@resend.dev";
    expect((await sendCode(email, { ip: nextIp() })).status).toBe(200);
    const otp = await readSignInCode(email);
    for (let i = 0; i < 5; i++) {
      await expect(
        auth.api.signInEmailOTP({ body: { email, otp: wrongCode(otp) } }),
      ).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
    }
    await expect(auth.api.signInEmailOTP({ body: { email, otp } })).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "TOO_MANY_ATTEMPTS" },
    });
  });

  test("another email's code is rejected as INVALID_OTP", async () => {
    const a = "delivered+owner-a@resend.dev";
    const b = "delivered+owner-b@resend.dev";
    expect((await sendCode(a, { ip: nextIp() })).status).toBe(200);
    expect((await sendCode(b, { ip: nextIp() })).status).toBe(200);
    const codeA = await readSignInCode(a);
    const codeB = await readSignInCode(b);
    const response = await signIn(b, codeA === codeB ? wrongCode(codeB) : codeA, nextIp());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_OTP" });
  });

  test("a new email signs in and gets a verified user; same email in other case reuses it", async () => {
    const mixed = " Delivered+Case@resend.dev".trim();
    const lower = "delivered+case@resend.dev";
    const ids: string[] = [];
    for (const email of [mixed, lower]) {
      expect((await sendCode(email, { ip: nextIp() })).status).toBe(200);
      const response = await signIn(email, await readSignInCode(email), nextIp());
      expect(response.status).toBe(200);
      const { user } = (await response.json()) as { user: { id: string; emailVerified: boolean } };
      expect(user.emailVerified).toBe(true);
      ids.push(user.id);
    }
    expect(ids[1]).toBe(ids[0]);
  });

  test("two tabs: the second send is a new email with the same code, and that code works", async () => {
    const email = "delivered+tabs@resend.dev";
    expect((await sendCode(email, { ip: nextIp() })).status).toBe(200);
    const first = await readSignInCode(email);
    expect((await sendCode(email, { ip: nextIp() })).status).toBe(200);
    expect(await readSignInCode(email)).toBe(first);
    // The email goes out in the background, after the response.
    await vi.waitFor(() => expect(sentTo(email)).toEqual([first, first]));
    expect(new Set(attemptsTo(email)).size).toBe(2);
    expect((await signIn(email, first, nextIp())).status).toBe(200);
  });

  test("sign-in with code: sixth request in 60 s from one IP is 429", async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) {
      const response = await signIn(`delivered+signin-rl${i}@resend.dev`, "000000", ip);
      expect(response.status).toBe(400);
    }
    expect((await signIn("delivered+signin-rl5@resend.dev", "000000", ip)).status).toBe(429);
  });
});

// Last in the file: the instance it builds leaves the exhausted allocation in the module registry,
// where the hook's lazy import of the guard would pick it up.
describe("the hourly email brake", () => {
  test("critical quota exhausted → reason quota and nothing is sent", async () => {
    // A second instance whose brake allows nothing in any hour, so the hour rolling over mid-test
    // cannot let a code through.
    vi.resetModules();
    vi.stubEnv("QUOTA_RESEND_EMAILS_HOURLY_FLOOR", "0");
    vi.stubEnv("QUOTA_RESEND_EMAILS_PEAK_MULTIPLIER", "0");
    const [{ auth: exhausted }, db] = await Promise.all([
      import("./server"),
      import("@reranker/db"),
    ]);
    const email = "delivered+quota@resend.dev";
    let response: Response;
    try {
      response = await sendCode(email, { ip: nextIp(), instance: exhausted });
    } finally {
      await db.endPools();
    }
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: "quota" });
    expect(Number(response.headers.get("X-Retry-After"))).toBeGreaterThan(0);
    expect(await pendingCodes(email)).toBe(0);
    expect(sentTo(email)).toEqual([]);
  });
});
