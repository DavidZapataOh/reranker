import { afterEach, expect, test, vi } from "vitest";
import { verifyTurnstile } from "./turnstile";

// Cloudflare's published testing secrets; they accept only the dummy token the testing site keys issue.
const ALWAYS_PASSES = "1x0000000000000000000000000000000AA";
const ALWAYS_FAILS = "2x0000000000000000000000000000000AA";
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("Siteverify accepts the dummy token with the always-passes secret", async () => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("TURNSTILE_SECRET_KEY", ALWAYS_PASSES);
  await expect(
    verifyTurnstile({ token: DUMMY_TOKEN, remoteIp: "203.0.113.7", expectedAction: "free_report" }),
  ).resolves.toEqual({ ok: true });
});

test("Siteverify rejects the dummy token with the always-fails secret", async () => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("TURNSTILE_SECRET_KEY", ALWAYS_FAILS);
  const result = await verifyTurnstile({ token: DUMMY_TOKEN, expectedAction: "lead_form" });
  expect(result).toMatchObject({ ok: false });
  expect(result.ok === false && result.errorCodes.length).toBeGreaterThan(0);
});
