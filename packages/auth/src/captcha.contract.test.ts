import { endPools, withSystem } from "@reranker/db";
import { verifications } from "@reranker/db/schema/auth";
import { eq } from "drizzle-orm";
import { afterAll, expect, test, vi } from "vitest";

// Only the Turnstile check is under contract here; delivery has its own contract test.
vi.mock("./send-auth-email", () => ({ sendAuthEmail: vi.fn() }));

// Cloudflare's published testing secrets; they accept only the dummy token the testing site keys issue.
const ALWAYS_PASSES = "1x0000000000000000000000000000000AA";
const ALWAYS_FAILS = "2x0000000000000000000000000000000AA";
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const EMAIL = "delivered+captcha-contract@resend.dev";

const secret = () => `${crypto.randomUUID()}${crypto.randomUUID()}`;
vi.stubEnv("APP_ENV", "development");
vi.stubEnv("BETTER_AUTH_SECRET", secret());
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
vi.stubEnv("RESEND_API_KEY", "re_test");
vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
vi.stubEnv("CAPACITY_HMAC_KEY", secret());

afterAll(async () => {
  await withSystem("test.cleanup", (tx) =>
    tx.delete(verifications).where(eq(verifications.identifier, `sign-in-otp-${EMAIL}`)),
  );
  await endPools();
});

// Each secret needs its own instance: the plugin reads it once, when the instance is built. A fresh
// module graph also opens its own pools, closed here.
async function sendWith(turnstileSecret: string): Promise<Response> {
  vi.resetModules();
  vi.stubEnv("TURNSTILE_SECRET_KEY", turnstileSecret);
  const [{ auth }, db] = await Promise.all([import("./server"), import("@reranker/db")]);
  try {
    return await auth.handler(
      new Request("http://localhost:3000/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          "x-real-ip": `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`,
          "x-captcha-response": DUMMY_TOKEN,
        },
        body: JSON.stringify({ email: EMAIL, type: "sign-in" }),
      }),
    );
  } finally {
    await db.endPools();
  }
}

test("the always-passes secret lets the code be sent", async () => {
  const response = await sendWith(ALWAYS_PASSES);
  expect(response.status).toBe(200);
});

test("the always-fails secret is refused with the plugin's code", async () => {
  const response = await sendWith(ALWAYS_FAILS);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "VERIFICATION_FAILED" });
});
