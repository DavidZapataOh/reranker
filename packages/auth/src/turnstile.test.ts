import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { verifyTurnstile } from "./turnstile";

const fetchMock = vi.fn<typeof fetch>();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sent = (call = 0) => {
  const [url, init] = fetchMock.mock.calls[call] ?? [];
  return { url, init, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
};

beforeEach(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "turnstile-secret");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("verifyTurnstile", () => {
  test("posts the secret, token, IP and an idempotency key to Siteverify", async () => {
    fetchMock.mockResolvedValue(json({ success: true, action: "free_report", "error-codes": [] }));
    await expect(
      verifyTurnstile({ token: "tok", remoteIp: "203.0.113.7", expectedAction: "free_report" }),
    ).resolves.toEqual({ ok: true });
    const { url, init, body } = sent();
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(body).toMatchObject({
      secret: "turnstile-secret",
      response: "tok",
      remoteip: "203.0.113.7",
    });
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("leaves remoteip out when the IP is unknown", async () => {
    fetchMock.mockResolvedValue(json({ success: true, action: "lead_form" }));
    await verifyTurnstile({ token: "tok", expectedAction: "lead_form" });
    expect(sent().body).not.toHaveProperty("remoteip");
  });

  test("returns Cloudflare's error codes on failure", async () => {
    fetchMock.mockResolvedValue(json({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    await expect(verifyTurnstile({ token: "tok", expectedAction: "free_report" })).resolves.toEqual(
      { ok: false, errorCodes: ["timeout-or-duplicate"] },
    );
  });

  test.each([
    ["another action", "lead_form"],
    ["no action", undefined],
  ])("a token solved for %s is rejected", async (_label, action) => {
    fetchMock.mockResolvedValue(json({ success: true, action }));
    await expect(verifyTurnstile({ token: "tok", expectedAction: "free_report" })).resolves.toEqual(
      { ok: false, errorCodes: ["action-mismatch"] },
    );
  });

  test("a testing secret's answer carries no action and still passes", async () => {
    fetchMock.mockResolvedValue(
      json({ success: true, "error-codes": [], metadata: { result_with_testing_key: true } }),
    );
    await expect(verifyTurnstile({ token: "tok", expectedAction: "free_report" })).resolves.toEqual(
      { ok: true },
    );
  });

  test("an empty token is rejected without calling Cloudflare", async () => {
    await expect(verifyTurnstile({ token: "", expectedAction: "free_report" })).resolves.toEqual({
      ok: false,
      errorCodes: ["missing-input-response"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a token longer than 2048 characters is rejected without calling Cloudflare", async () => {
    await expect(
      verifyTurnstile({ token: "x".repeat(2049), expectedAction: "free_report" }),
    ).resolves.toEqual({ ok: false, errorCodes: ["invalid-input-response"] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("retries once with the same idempotency key after a server error", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ success: false, "error-codes": ["internal-error"] }, 500))
      .mockResolvedValueOnce(json({ success: true, action: "free_report" }));
    await expect(verifyTurnstile({ token: "tok", expectedAction: "free_report" })).resolves.toEqual(
      { ok: true },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(1).body.idempotency_key).toBe(sent(0).body.idempotency_key);
  });

  test("a network failure on both attempts reports internal-error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(verifyTurnstile({ token: "tok", expectedAction: "free_report" })).resolves.toEqual(
      { ok: false, errorCodes: ["internal-error"] },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("every attempt carries a timeout", async () => {
    fetchMock.mockResolvedValue(json({ success: true, action: "free_report" }));
    await verifyTurnstile({ token: "tok", expectedAction: "free_report" });
    expect(sent().init?.signal).toBeInstanceOf(AbortSignal);
  });
});
