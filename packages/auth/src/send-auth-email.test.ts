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

const delivery = vi.hoisted(() => ({ recordEmailDelivery: vi.fn() }));
vi.mock("./telemetry", () => delivery);

const { idempotencyKey, sendAuthEmail } = await import("./send-auth-email");

const attempt = "0b6f3c1e-5a2d-4e8f-9c71-2d4b8a6e1f30";

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
      sendAuthEmail("sign-in-code", "ana@example.co", { otp: "482913" }, { attempt }),
    ).resolves.toEqual({ id: "email-1" });
    const [payload, options] = resend.send.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      from: "Reranker <codigos@mail.reranker.co>",
      to: "ana@example.co",
      subject: "482913 es tu código para entrar a Reranker",
    });
    expect(payload.html).toContain('lang="es-CO"');
    expect(payload.html).toMatch(/>482913<\/td>/);
    expect(payload.text).toContain("482913");
    expect(payload.text).not.toMatch(/482\s+913/);
    expect(payload.text).not.toContain("<");
    expect(options).toEqual({
      idempotencyKey: idempotencyKey("sign-in-code", attempt),
    });
    expect(delivery.recordEmailDelivery).toHaveBeenCalledExactlyOnceWith(true);
  });

  test("passes the requested place to the email and keeps it out of the subject", async () => {
    await sendAuthEmail(
      "sign-in-code",
      "ana@example.co",
      { otp: "482913", locale: "es-CO", requestedFrom: { city: "Cali", country: "Colombia" } },
      { attempt },
    );
    const [payload] = resend.send.mock.calls[0] ?? [];
    expect(payload.html).toContain("Se pidió desde Cali, Colombia.");
    expect(payload.text).toContain("Se pidió desde Cali, Colombia.");
    expect(payload.subject).not.toContain("Cali");
  });

  test("imports without the key and creates the client once, on the first send", async () => {
    vi.resetModules();
    vi.stubEnv("RESEND_API_KEY", "");
    const fresh = await import("./send-auth-email");
    expect(resend.construct).not.toHaveBeenCalled();
    await expect(
      fresh.sendAuthEmail("sign-in-code", "ana@example.co", { otp: "482913" }, { attempt }),
    ).rejects.toThrow(/RESEND_API_KEY \(missing\)/);
    vi.stubEnv("RESEND_API_KEY", "re_test");
    await fresh.sendAuthEmail("sign-in-code", "ana@example.co", { otp: "482913" }, { attempt });
    await fresh.sendAuthEmail(
      "sign-in-code",
      "ana@example.co",
      { otp: "111111" },
      { attempt: crypto.randomUUID() },
    );
    expect(resend.construct).toHaveBeenCalledExactlyOnceWith("re_test");
  });

  test("fails with service_unavailable and a bare event when Resend returns an error", async () => {
    const cause = { name: "rate_limit_exceeded", message: "Too many requests" };
    resend.send.mockResolvedValue({ data: null, error: cause });
    const failure = await sendAuthEmail(
      "sign-in-code",
      "ana@example.co",
      { otp: "482913" },
      { attempt },
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: "service_unavailable", cause });
    expect((failure as AppError).message).not.toMatch(/ana@example|482913/);
    expect(telemetry.captureServerEvent).toHaveBeenCalledExactlyOnceWith(
      { name: "auth_email_failed", props: {} },
      { subject: { system: true } },
    );
    expect(delivery.recordEmailDelivery).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("idempotency", () => {
  const keyOf = (call: number) =>
    (resend.send.mock.calls[call]?.[1] as { idempotencyKey: string } | undefined)?.idempotencyKey;

  test("is namespaced by template and fits Resend's 256-character limit", () => {
    const key = idempotencyKey("sign-in-code", attempt);
    expect(key).toBe(`sign-in-code/${attempt}`);
    expect(key.length).toBeLessThanOrEqual(256);
  });

  test("two resends of the same code to the same address are two emails", async () => {
    const data = { otp: "482913" };
    await sendAuthEmail("sign-in-code", "ana@example.co", data, { attempt: crypto.randomUUID() });
    await sendAuthEmail("sign-in-code", "ana@example.co", data, { attempt: crypto.randomUUID() });
    expect(keyOf(0)).not.toBe(keyOf(1));
  });

  test("a retry of the same attempt reuses its key, so Resend sends it once", async () => {
    const data = { otp: "482913" };
    await sendAuthEmail("sign-in-code", "ana@example.co", data, { attempt });
    await sendAuthEmail("sign-in-code", "ana@example.co", data, { attempt });
    expect(keyOf(0)).toBe(idempotencyKey("sign-in-code", attempt));
    expect(keyOf(1)).toBe(keyOf(0));
  });
});
