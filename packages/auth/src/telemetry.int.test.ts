import { endPools, withSystem } from "@reranker/db";
import { users, verifications } from "@reranker/db/schema/auth";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { readSignInCode } from "../test/sign-in-code";

// Outside production captureServerEvent sends nothing, so the test watches the calls instead.
const telemetry = vi.hoisted(() => ({ captureServerEvent: vi.fn(), sendOpsAlert: vi.fn() }));
vi.mock("@reranker/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/telemetry")>()),
  ...telemetry,
}));

const mail = vi.hoisted(() => ({ sendAuthEmail: vi.fn() }));
vi.mock("./send-auth-email", () => mail);

const secret = () => `${crypto.randomUUID()}${crypto.randomUUID()}`;
vi.stubEnv("APP_ENV", "development");
vi.stubEnv("BETTER_AUTH_SECRET", secret());
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "google-client-id.apps.googleusercontent.com");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
vi.stubEnv("RESEND_API_KEY", "re_test");
vi.stubEnv("TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA");
vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
vi.stubEnv("CAPACITY_HMAC_KEY", secret());
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const SIGN_IN_KEY = "auth.sign_in";

const { auth } = await import("./server");

const emails = new Set<string>();

// The window is global, so it starts empty for this file; it runs alone, after every other
// file that signs in.
async function resetSignInWindow(): Promise<void> {
  await withSystem("test.velocity-reset", (tx) =>
    tx.execute(sql`delete from ops.velocity_buckets where key = ${SIGN_IN_KEY}`),
  );
}

async function attemptsRecorded(): Promise<number> {
  const { rows } = await withSystem("test.velocity-read", (tx) =>
    tx.execute<{ total: number }>(
      sql`select coalesce(sum(count), 0)::int as total from ops.velocity_buckets where key = ${SIGN_IN_KEY}`,
    ),
  );
  return rows[0]?.total ?? 0;
}

beforeAll(resetSignInWindow);

afterAll(async () => {
  const addresses = [...emails];
  await resetSignInWindow();
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

function nextIp(): string {
  const octet = () => Math.floor(Math.random() * 256);
  return `10.${octet()}.${octet()}.${1 + Math.floor(Math.random() * 254)}`;
}

function post(path: string, body: unknown, headers: Record<string, string>) {
  return auth.handler(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const eventsNamed = (name: string) =>
  telemetry.captureServerEvent.mock.calls.filter(([event]) => event.name === name);

describe("auth events", () => {
  test("a first sign-in with a code is a new email_otp user, named by id only", async () => {
    const email = `delivered+telemetry-${crypto.randomUUID()}@resend.dev`;
    emails.add(email);
    const sent = await post(
      "/email-otp/send-verification-otp",
      { email, type: "sign-in" },
      { "x-real-ip": nextIp(), "x-captcha-response": DUMMY_TOKEN },
    );
    expect(sent.status).toBe(200);
    expect(eventsNamed("auth_code_sent")).toHaveLength(1);

    const otp = await readSignInCode(email);
    const signedIn = await post("/sign-in/email-otp", { email, otp }, { "x-real-ip": nextIp() });
    expect(signedIn.status).toBe(200);

    const [user] = await withSystem("test.read-user", (tx) =>
      tx.select({ id: users.id }).from(users).where(eq(users.email, email)),
    );
    expect(eventsNamed("auth_sign_in")).toEqual([
      [
        { name: "auth_sign_in", props: { method: "email_otp", new_user: true } },
        expect.objectContaining({ subject: { user: user?.id } }),
      ],
    ]);
    expect(JSON.stringify(telemetry.captureServerEvent.mock.calls)).not.toContain(email);
  });
});

describe("sign-in failure alert", () => {
  test("21 failed codes within 10 minutes raise exactly one alert", async () => {
    await resetSignInWindow();
    telemetry.sendOpsAlert.mockClear();
    for (let i = 0; i < 21; i++) {
      const email = `delivered+wrong-${i}-${crypto.randomUUID()}@resend.dev`;
      const response = await post(
        "/sign-in/email-otp",
        { email, otp: "000000" },
        { "x-real-ip": nextIp() },
      );
      expect(response.status).toBe(400);
    }
    expect(eventsNamed("auth_sign_in_failed").at(-1)?.[0]).toEqual({
      name: "auth_sign_in_failed",
      props: { reason: "invalid_otp" },
    });
    // Each attempt is recorded in the background, after its response.
    await vi.waitFor(async () => expect(await attemptsRecorded()).toBe(21), { timeout: 10_000 });
    await vi.waitFor(() => expect(telemetry.sendOpsAlert).toHaveBeenCalled());
    expect(telemetry.sendOpsAlert).toHaveBeenCalledExactlyOnceWith("auth-sign-in-failure-spike", {
      attempts_10m: 20,
      failed_10m: 20,
    });
  });
});
