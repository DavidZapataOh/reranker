import { AppError } from "@reranker/schema";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const resend = vi.hoisted(() => ({
  send: vi.fn(),
  construct: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resend.send };
    constructor(...args: unknown[]) {
      resend.construct(...args);
    }
  },
}));

const telemetry = vi.hoisted(() => ({ captureServerEvent: vi.fn() }));
vi.mock("@reranker/telemetry", () => telemetry);

const { idempotencyKey, sendAuthEmail } = await import("./send-auth-email");

beforeEach(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  resend.send.mockResolvedValue({ data: { id: "email-1" }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("sendAuthEmail", () => {
  test("sends html and text from the verified sender with an idempotency key", async () => {
    await expect(
      sendAuthEmail("sign-in-code", "ana@example.co", { otp: "482913" }),
    ).resolves.toEqual({ id: "email-1" });
    const [payload, options] = resend.send.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      from: "Reranker <codigos@mail.reranker.co>",
      to: "ana@example.co",
      subject: "Tu código para entrar a Reranker: 482913",
    });
    expect(payload.html).toContain("482 913");
    expect(payload.text).toContain("482 913");
    expect(payload.text).not.toContain("<");
    expect(options).toEqual({
      idempotencyKey: idempotencyKey("sign-in-code", "ana@example.co", "482913"),
    });
  });

  test("imports without the key and creates the client once, on the first send", async () => {
    vi.resetModules();
    vi.stubEnv("RESEND_API_KEY", "");
    const fresh = await import("./send-auth-email");
    expect(resend.construct).not.toHaveBeenCalled();
    await expect(
      fresh.sendAuthEmail("sign-in-code", "ana@example.co", { otp: "482913" }),
    ).rejects.toThrow(/RESEND_API_KEY \(missing\)/);
    vi.stubEnv("RESEND_API_KEY", "re_test");
    await fresh.sendAuthEmail("sign-in-code", "ana@example.co", { otp: "482913" });
    await fresh.sendAuthEmail("sign-in-code", "ana@example.co", { otp: "111111" });
    expect(resend.construct).toHaveBeenCalledExactlyOnceWith("re_test");
  });

  test("fails with service_unavailable and a bare event when Resend returns an error", async () => {
    const cause = { name: "rate_limit_exceeded", message: "Too many requests" };
    resend.send.mockResolvedValue({ data: null, error: cause });
    const failure = await sendAuthEmail("sign-in-code", "ana@example.co", { otp: "482913" }).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: "service_unavailable", cause });
    expect((failure as AppError).message).not.toMatch(/ana@example|482913/);
    expect(telemetry.captureServerEvent).toHaveBeenCalledExactlyOnceWith(
      { name: "auth_email_failed", props: {} },
      { subject: { system: true } },
    );
  });
});

describe("idempotencyKey", () => {
  test("is deterministic and namespaced", () => {
    const key = idempotencyKey("sign-in-code", "ana@example.co", "482913");
    expect(key).toMatch(/^sign-in-code\/[0-9a-f]{64}$/);
    expect(idempotencyKey("sign-in-code", "ana@example.co", "482913")).toBe(key);
  });

  test("differs per recipient and per code", () => {
    const base = idempotencyKey("sign-in-code", "ana@example.co", "482913");
    expect(idempotencyKey("sign-in-code", "luis@example.co", "482913")).not.toBe(base);
    expect(idempotencyKey("sign-in-code", "ana@example.co", "482914")).not.toBe(base);
  });
});
