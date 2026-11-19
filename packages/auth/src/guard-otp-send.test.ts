import { assertOpaqueKey } from "@reranker/jobs";
import { QuotaExceededError } from "@reranker/jobs/errors";
import type { TokenBucket } from "@reranker/jobs/rate";
import { AppError, ERRORS } from "@reranker/schema";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);

const jobs = vi.hoisted(() => ({
  takeAllTokens: vi.fn(),
  refundAllTokens: vi.fn(),
  consumeQuota: vi.fn(),
}));

vi.mock("@reranker/jobs/rate", () => ({
  takeAllTokens: jobs.takeAllTokens,
  refundAllTokens: jobs.refundAllTokens,
}));
vi.mock("@reranker/jobs/quota", () => ({ consumeQuota: jobs.consumeQuota }));

const domain = vi.hoisted(() => ({ checkEmailDomain: vi.fn() }));
vi.mock("./email-domain", () => domain);

const { guardOtpSend, normalizeEmailForLimits } = await import("./guard-otp-send");

const HMAC_KEY = "k".repeat(32);

type GuardContext = Parameters<typeof guardOtpSend>[0];

function context(email: unknown, ip?: string): GuardContext {
  const headers = new Headers(ip ? { "x-real-ip": ip } : {});
  return {
    body: { email, type: "sign-in" },
    headers,
    request: new Request("http://localhost:3000/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers,
    }),
    context: { options: { advanced: { ipAddress: { ipAddressHeaders: ["x-real-ip"] } } } },
  } as unknown as GuardContext;
}

const taken = () => jobs.takeAllTokens.mock.calls.flatMap(([buckets]) => buckets as TokenBucket[]);
const takenKeys = () => taken().map(({ key }) => key);
const refundedKeys = () =>
  jobs.refundAllTokens.mock.calls.flatMap(([buckets]) =>
    (buckets as TokenBucket[]).map((b) => b.key),
  );

beforeEach(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("CAPACITY_HMAC_KEY", HMAC_KEY);
  domain.checkEmailDomain.mockImplementation(async () => {
    calls.push("domain");
    return { ok: true };
  });
  jobs.takeAllTokens.mockImplementation(async (buckets: TokenBucket[]) => {
    calls.push("tokens");
    return { ok: true, remaining: buckets.map(() => 1), retryAfterMs: 0 };
  });
  jobs.refundAllTokens.mockResolvedValue(undefined);
  jobs.consumeQuota.mockImplementation(async () => {
    calls.push("quota");
  });
});

afterEach(() => {
  calls.length = 0;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("normalizeEmailForLimits", () => {
  test.each([
    ["A.na+x@Gmail.com", "ana@gmail.com"],
    [" ana@gmail.com ", "ana@gmail.com"],
    ["a.n.a+promo+x@googlemail.com", "ana@gmail.com"],
    ["Ana.Perez+x@Empresa.co", "ana.perez+x@empresa.co"],
  ])("%s → %s", (email, normalized) => {
    expect(normalizeEmailForLimits(email)).toBe(normalized);
  });
});

describe("guardOtpSend", () => {
  test("checks the domain, then every limit in one take, then the email quota", async () => {
    await guardOtpSend(context("ana@empresa.co", "203.0.113.7"));
    expect(calls).toEqual(["domain", "tokens", "quota"]);
    expect(takenKeys()).toHaveLength(4);
    expect(jobs.consumeQuota).toHaveBeenCalledExactlyOnceWith("resend.emails", {
      priority: "critical",
    });
  });

  test("limits: 3 per hour and 5 per day per email, 5 per day per IP and 15 per /24", async () => {
    await guardOtpSend(context("ana@empresa.co", "203.0.113.7"));
    const day = 86_400;
    expect(taken().map(({ limits }) => limits)).toEqual([
      { capacity: 3, refillPerSecond: 3 / 3_600 },
      { capacity: 5, refillPerSecond: 5 / day },
      { capacity: 5, refillPerSecond: 5 / day },
      { capacity: 15, refillPerSecond: 15 / day },
    ]);
  });

  test("no key holds the address or the IP, and every key is opaque", async () => {
    await guardOtpSend(context("ana@empresa.co", "203.0.113.7"));
    for (const key of takenKeys()) {
      expect(key).not.toContain("@");
      expect(key).not.toContain("ana");
      expect(key).not.toContain("203.0.113");
      expect(() => assertOpaqueKey(key)).not.toThrow();
      expect(key).toMatch(/^otp:(email|ip|net):/);
    }
  });

  test("the email keys come from the normalized address", async () => {
    await guardOtpSend(context("A.na+1@Gmail.com", "203.0.113.7"));
    const first = takenKeys().slice(0, 2);
    jobs.takeAllTokens.mockClear();
    await guardOtpSend(context("ana@gmail.com", "198.51.100.9"));
    expect(takenKeys().slice(0, 2)).toEqual(first);
  });

  test("two addresses in the same /24 share the network bucket only", async () => {
    await guardOtpSend(context("ana@empresa.co", "203.0.113.7"));
    const [, , ipA, netA] = takenKeys();
    jobs.takeAllTokens.mockClear();
    await guardOtpSend(context("ana@empresa.co", "203.0.113.200"));
    const [, , ipB, netB] = takenKeys();
    expect(ipA).not.toBe(ipB);
    expect(netA).toBe(netB);
  });

  test("IPv6 addresses are keyed too", async () => {
    await guardOtpSend(context("ana@empresa.co", "2001:db8:85a3::8a2e:370:7334"));
    expect(takenKeys()).toHaveLength(4);
    for (const key of takenKeys()) expect(() => assertOpaqueKey(key)).not.toThrow();
  });

  test("a different HMAC key yields different bucket keys", async () => {
    await guardOtpSend(context("ana@empresa.co", "203.0.113.7"));
    const first = takenKeys();
    jobs.takeAllTokens.mockClear();
    vi.stubEnv("CAPACITY_HMAC_KEY", "j".repeat(32));
    await guardOtpSend(context("ana@empresa.co", "203.0.113.7"));
    expect(takenKeys()).not.toEqual(first);
  });

  test.each(["disposable", "no_mx"] as const)(
    "a %s domain is rejected before any token or quota is taken",
    async (reason) => {
      domain.checkEmailDomain.mockResolvedValue({ ok: false, reason });
      await expect(guardOtpSend(context("ana@x.example", "203.0.113.7"))).rejects.toMatchObject({
        statusCode: 400,
        body: { reason },
      });
      expect(jobs.takeAllTokens).not.toHaveBeenCalled();
      expect(jobs.consumeQuota).not.toHaveBeenCalled();
    },
  );

  test("a denied limit is 429 with the wait, gives nothing back and takes no quota", async () => {
    jobs.takeAllTokens.mockResolvedValue({
      ok: false,
      remaining: [1, 1, 0, 1],
      retryAfterMs: 4_200,
    });
    const error = await guardOtpSend(context("ana@empresa.co", "203.0.113.7")).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 429, body: { reason: "rate_limited" } });
    expect(new Headers(error.headers).get("X-Retry-After")).toBe("5");
    expect(jobs.refundAllTokens).not.toHaveBeenCalled();
    expect(jobs.consumeQuota).not.toHaveBeenCalled();
  });

  test("an exhausted quota is 503 until the reset and gives every token back", async () => {
    const resetsAt = new Date(Date.now() + 90_000);
    jobs.consumeQuota.mockRejectedValue(
      new QuotaExceededError("resend.emails", "critical", resetsAt),
    );
    const error = await guardOtpSend(context("ana@empresa.co", "203.0.113.7")).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 503, body: { reason: "quota" } });
    expect(Number(new Headers(error.headers).get("X-Retry-After"))).toBeGreaterThanOrEqual(89);
    expect(refundedKeys()).toEqual(takenKeys());
  });

  test("a database too busy to decide the quota is 503 with its wait and gives every token back", async () => {
    jobs.consumeQuota.mockRejectedValue(
      new AppError("service_unavailable", { retryAfterSeconds: 2 }),
    );
    const error = await guardOtpSend(context("ana@empresa.co", "203.0.113.7")).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 503, body: { reason: "unavailable" } });
    expect(new Headers(error.headers).get("X-Retry-After")).toBe("2");
    expect(refundedKeys()).toEqual(takenKeys());
  });

  test("limits the database could not answer are 503, give nothing back and take no quota", async () => {
    jobs.takeAllTokens.mockRejectedValue(new AppError("timeout"));
    const error = await guardOtpSend(context("ana@empresa.co", "203.0.113.7")).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 503, body: { reason: "unavailable" } });
    expect(new Headers(error.headers).get("X-Retry-After")).toBe(
      String(ERRORS.timeout.retryAfterSeconds),
    );
    expect(jobs.refundAllTokens).not.toHaveBeenCalled();
    expect(jobs.consumeQuota).not.toHaveBeenCalled();
  });

  test("a refund that fails while the database is busy still answers 503", async () => {
    jobs.consumeQuota.mockRejectedValue(new AppError("service_unavailable"));
    jobs.refundAllTokens.mockRejectedValue(new AppError("service_unavailable"));
    const error = await guardOtpSend(context("ana@empresa.co", "203.0.113.7")).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 503, body: { reason: "unavailable" } });
    expect(new Headers(error.headers).get("X-Retry-After")).toBe(
      String(ERRORS.service_unavailable.retryAfterSeconds),
    );
  });

  test.each([
    ["a non-retryable error", new AppError("internal")],
    ["a plain error", new Error("connection reset")],
  ])("%s from the quota propagates", async (_label, failure) => {
    jobs.consumeQuota.mockRejectedValue(failure);
    await expect(guardOtpSend(context("ana@empresa.co", "203.0.113.7"))).rejects.toBe(failure);
  });

  test("a non-retryable error from the limits propagates", async () => {
    const failure = new Error("connection reset");
    jobs.takeAllTokens.mockRejectedValue(failure);
    await expect(guardOtpSend(context("ana@empresa.co", "203.0.113.7"))).rejects.toBe(failure);
    expect(jobs.consumeQuota).not.toHaveBeenCalled();
  });

  test("without a client IP only the email buckets apply", async () => {
    const ctx = context("ana@empresa.co");
    (ctx.context.options as { advanced: unknown }).advanced = {
      ipAddress: { disableIpTracking: true },
    };
    await guardOtpSend(ctx);
    expect(takenKeys()).toHaveLength(2);
  });

  test("a body without an email is left to the endpoint's validation", async () => {
    await guardOtpSend(context(undefined, "203.0.113.7"));
    expect(calls).toEqual([]);
  });
});
