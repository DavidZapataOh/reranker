import { AppError } from "@reranker/schema";
import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureServerEvent: vi.fn(),
  headers: vi.fn(),
  getLocale: vi.fn(async () => "es-CO"),
}));

vi.mock("@reranker/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/telemetry")>()),
  captureServerEvent: mocks.captureServerEvent,
}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next-intl/server", () => ({ getLocale: mocks.getLocale }));

const { problemResponse, runAction } = await import("./problem");

const request = (headers: Record<string, string> = { "x-vercel-id": "iad1::abc" }) =>
  new Request("https://reranker.co/api/x?q=1", { headers });

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.headers.mockResolvedValue(new Headers({ "x-vercel-id": "iad1::act" }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.captureServerEvent.mockReset();
});

describe("problemResponse", () => {
  test("sets problem+json, Retry-After and logs a warning without the cause", async () => {
    const res = await problemResponse(
      new AppError("rate_limited", { retryAfterSeconds: 30, cause: new Error("secret") }),
      request(),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toMatchObject({
      code: "rate_limited",
      request_id: "iad1::abc",
      instance: "/api/x",
      retry_after: 30,
    });
    expect(warn).toHaveBeenCalledWith(
      "problem returned",
      expect.objectContaining({ code: "rate_limited", status: 429, request_id: "iad1::abc" }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    expect(error).not.toHaveBeenCalled();
    expect(mocks.captureServerEvent).toHaveBeenCalledWith(
      { name: "problem_returned", props: { code: "rate_limited", status: 429 } },
      { subject: { system: true } },
    );
  });

  test("omits Retry-After when the error has no wait", async () => {
    const res = await problemResponse(new AppError("not_found"), request());
    expect(res.status).toBe(404);
    expect(res.headers.has("retry-after")).toBe(false);
  });

  test("an unknown error becomes internal and its details stay out of the body", async () => {
    const res = await problemResponse(
      new Error("select * from users where id = 7 failed"),
      request(),
    );
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({ code: "internal" });
    expect(text).not.toMatch(/select|users|stack|at /i);
    expect(mocks.captureServerEvent).toHaveBeenCalledWith(
      { name: "problem_returned", props: { code: "internal", status: 500 } },
      { subject: { system: true } },
    );
  });

  test("a 5xx logs an error with the cause redacted of personal data", async () => {
    const cause = new Error("lookup failed for ana@example.com");
    const res = await problemResponse(new AppError("internal", { cause }), request());
    expect(await res.text()).not.toContain("ana@example.com");
    expect(error).toHaveBeenCalledWith(
      "problem returned",
      expect.objectContaining({ code: "internal", status: 500, request_id: "iad1::abc" }),
    );
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain("lookup failed");
    expect(logged).not.toContain("ana@example.com");
  });

  test("still answers when telemetry throws", async () => {
    mocks.captureServerEvent.mockImplementation(() => {
      throw new Error("posthog down");
    });
    const res = await problemResponse(new AppError("not_found"), request());
    expect(res.status).toBe(404);
  });
});

describe("runAction", () => {
  test("returns data on success without reporting", async () => {
    await expect(runAction(async () => 7)).resolves.toEqual({ ok: true, data: 7 });
    expect(mocks.captureServerEvent).not.toHaveBeenCalled();
  });

  test("returns a problem, logs and tracks a known failure", async () => {
    const result = await runAction(async () => {
      throw new AppError("forbidden");
    });
    expect(result).toMatchObject({ ok: false, problem: { code: "forbidden", status: 403 } });
    expect(warn).toHaveBeenCalledWith(
      "problem returned",
      expect.objectContaining({ code: "forbidden", status: 403, request_id: "iad1::act" }),
    );
    expect(mocks.captureServerEvent).toHaveBeenCalledWith(
      { name: "problem_returned", props: { code: "forbidden", status: 403 } },
      { subject: { system: true } },
    );
  });

  test("an unexpected failure is internal and logs its redacted cause", async () => {
    const result = await runAction(async () => {
      throw new Error("boom for ana@example.com");
    });
    expect(result).toMatchObject({ ok: false, problem: { code: "internal", status: 500 } });
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain("boom");
    expect(logged).not.toContain("ana@example.com");
    expect(JSON.stringify(result)).not.toContain("boom");
  });

  test("works outside a request, without a request id", async () => {
    mocks.headers.mockRejectedValue(new Error("outside a request scope"));
    const result = await runAction(async () => {
      throw new AppError("not_found");
    });
    expect(result).toMatchObject({ ok: false });
    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty("request_id");
  });

  test("rethrows redirect() instead of turning it into a problem", async () => {
    await expect(runAction(async () => redirect("/app"))).rejects.toThrow();
    expect(mocks.captureServerEvent).not.toHaveBeenCalled();
  });

  test("still returns the problem when telemetry throws", async () => {
    mocks.captureServerEvent.mockImplementation(() => {
      throw new Error("posthog down");
    });
    const result = await runAction(async () => {
      throw new AppError("not_found");
    });
    expect(result).toMatchObject({ ok: false, problem: { code: "not_found" } });
  });
});
