import { describe, expect, test } from "vitest";
import { classifyResponse } from "../../../src/brightdata/status";

const utf8 = (text: string) => new TextEncoder().encode(text);

const RECORD = `[{"url":"https://www.perplexity.ai","prompt":"mejor odont\\u00f3logo en Medell\\u00edn","answer_text":"Cl\\u00ednica Dental","index":7}]`;

const classify = (http: number | null, body: string, headers: Record<string, string> = {}) =>
  classifyResponse(http, utf8(body), new Headers(headers));

describe("classifyResponse", () => {
  test.each([
    ["records", 200, RECORD, { kind: "ok", record: { answer_text: "Clínica Dental", index: 7 } }],
    [
      "error record",
      200,
      '[{"input":{"prompt":"x"},"error":"The navigation resulted in a dead page","error_code":"dead_page"}]',
      { kind: "provider_error", errorCode: "dead_page" },
    ],
    [
      "error record without a code",
      200,
      '[{"error":"Something failed"}]',
      { kind: "provider_error", errorCode: null },
    ],
    ["empty array", 200, "[]", { kind: "provider_error", errorCode: null }],
    ["not json", 200, "not json", { kind: "provider_error", errorCode: "invalid_json" }],
    [
      "unexpected object",
      200,
      '{"foo":1}',
      { kind: "provider_error", errorCode: "unexpected_body" },
    ],
    ["array of scalars", 200, "[1]", { kind: "provider_error", errorCode: "unexpected_body" }],
  ])("200 with %s", (_, http, body, expected) => {
    expect(classify(http, body)).toMatchObject(expected);
  });

  test("an error record next to a real one still yields the real record", () => {
    const body = `[{"error":"x","error_code":"dead_page"},${RECORD.slice(1)}`;
    expect(classify(200, body)).toMatchObject({ kind: "ok", record: { index: 7 } });
  });

  test.each([
    [401, "Invalid credentials", "unauthorized"],
    [402, "{error: 'Your current balance is insufficient …'}", "insufficient_balance"],
    [403, "Access denied.", "forbidden"],
  ])("%i is an account rejection that alerts and never opens the breaker", (http, body, code) => {
    const out = classify(http, body);
    expect(out).toMatchObject({ kind: "error", breaker: "none", alert: "rejected" });
    if (out.kind !== "error") throw new Error("expected an error");
    expect(out.error).toMatchObject({
      name: "ProviderRejected",
      provider: "brightdata",
      providerCode: code,
    });
  });

  test.each([
    [
      '{"error":"Invalid input provided","code":"validation_error","errors":[["prompt","x"]]}',
      "validation_error",
    ],
    ['{"error":"Parser cannot parse input: x","code":"parse_error"}', "parse_error"],
    ["No data to trigger", "http_400"],
  ])("400 %s is our own input error, never retried", (body, code) => {
    const out = classify(400, body);
    expect(out).toMatchObject({ kind: "error", breaker: "none" });
    expect(out).not.toHaveProperty("alert");
    if (out.kind !== "error") throw new Error("expected an error");
    expect(out.error).toMatchObject({ name: "ProviderRejected", providerCode: code });
  });

  test("404 from a missing dataset or snapshot is rejected", () => {
    const out = classify(404, '{"error":"Snapshot not found"}');
    if (out.kind !== "error") throw new Error("expected an error");
    expect(out.error).toMatchObject({ name: "ProviderRejected", providerCode: "not_found" });
  });

  test.each([500, 502, 503])("%i is an outage", (http) => {
    const out = classify(http, "oops");
    expect(out).toMatchObject({ kind: "error", breaker: "failure" });
    if (out.kind !== "error") throw new Error("expected an error");
    expect(out.error).toMatchObject({ name: "ProviderUnavailable", provider: "brightdata" });
  });

  test("a 5xx honours its Retry-After", () => {
    const out = classify(503, "busy", { "retry-after": "30" });
    if (out.kind !== "error") throw new Error("expected an error");
    expect(out.error).toMatchObject({ retryAfterMs: 30_000 });
  });

  test("no response at all (timeout or network) is an outage", () => {
    expect(classifyResponse(null, new Uint8Array(), new Headers())).toMatchObject({
      kind: "error",
      breaker: "failure",
      error: { name: "ProviderUnavailable" },
    });
  });

  test("a 202 without a snapshot id is a broken answer", () => {
    expect(classify(202, "{}")).toMatchObject({ kind: "error", breaker: "failure" });
  });

  test("an unknown 4xx is rejected with its status as the code", () => {
    const out = classify(418, "teapot");
    if (out.kind !== "error") throw new Error("expected an error");
    expect(out.error).toMatchObject({ name: "ProviderRejected", providerCode: "http_418" });
  });

  test("errors never carry the response body", () => {
    const echoed = "prompt-echo-123";
    for (const http of [400, 401, 402, 404, 429, 500]) {
      const out = classify(http, `{"error":"${echoed}","code":"${echoed}"}`);
      if (out.kind !== "error") throw new Error("expected an error");
      expect(out.error.message).not.toContain(echoed);
    }
  });
});

describe("snapshot progress bodies", () => {
  const failed = (message: string) =>
    classify(200, JSON.stringify({ snapshot_id: "s_1", status: "failed", error_message: message }));

  test.each([
    "Something went wrong. Bright Data is looking into it.",
    "Internal Server Error",
    "Failed to download response",
    "Failed to trigger collector",
  ])("failed with %s is a retryable outage", (message) => {
    expect(failed(message)).toMatchObject({
      kind: "error",
      breaker: "failure",
      error: { name: "ProviderUnavailable" },
    });
  });

  test.each([
    ["Account is suspended", "account_suspended"],
    ["Account is new, please activate it in account settings. URL", "account_inactive"],
  ])("failed with %s rejects and alerts", (message, code) => {
    expect(failed(message)).toMatchObject({
      kind: "error",
      breaker: "none",
      alert: "rejected",
      error: { name: "ProviderRejected", providerCode: code },
    });
  });

  test("failed input validation is our own rejection", () => {
    expect(failed("Input validation failed: prompt is required")).toMatchObject({
      kind: "error",
      breaker: "none",
      error: { name: "ProviderRejected", providerCode: "validation_error" },
    });
  });

  test.each([
    ["Snapshot is empty", "snapshot_empty"],
    ["No data found in discovery", "snapshot_empty"],
  ])("failed with %s is a missing answer, sealed at no cost", (message, code) => {
    expect(failed(message)).toMatchObject({ kind: "provider_error", errorCode: code });
  });

  test("a canceled snapshot is retryable but no outage", () => {
    expect(classify(200, '{"snapshot_id":"s_1","status":"canceled"}')).toMatchObject({
      kind: "error",
      breaker: "none",
      error: { name: "ProviderUnavailable" },
    });
  });

  test("a 4xx or 5xx from a progress poll classifies like one from the scrape", () => {
    expect(classify(500, "Internal server error")).toMatchObject({ breaker: "failure" });
    expect(classify(401, '{"error":"User authentication is required"}')).toMatchObject({
      alert: "rejected",
    });
  });
});

describe("429", () => {
  test("is rate limited, outside the breaker, using Retry-After seconds", () => {
    const out = classify(429, "You have too many running jobs for this dataset.", {
      "retry-after": "12",
    });
    expect(out).toMatchObject({ kind: "error", breaker: "none" });
    if (out.kind !== "error") throw new Error("expected an error");
    expect(out.error).toMatchObject({ name: "RateLimited", retryAfterMs: 12_000 });
  });

  test("reads a Retry-After date", () => {
    const at = new Date(Date.now() + 20_000).toUTCString();
    const out = classify(429, "x", { "retry-after": at });
    if (out.kind !== "error") throw new Error("expected an error");
    const { retryAfterMs } = out.error as { retryAfterMs: number };
    expect(retryAfterMs).toBeGreaterThan(18_000);
    expect(retryAfterMs).toBeLessThanOrEqual(20_000);
  });

  test.each([
    [undefined, 2000],
    [1, 2000],
    [2, 4000],
    [3, 8000],
    [5, 32_000],
    [9, 32_000],
  ])(
    "without Retry-After, attempt %s backs off %i ms plus up to a second of jitter",
    (attempt, base) => {
      const waits = Array.from({ length: 20 }, () => {
        const out = classifyResponse(429, utf8("x"), new Headers(), attempt ? { attempt } : {});
        if (out.kind !== "error") throw new Error("expected an error");
        return (out.error as { retryAfterMs: number }).retryAfterMs;
      });
      for (const ms of waits) {
        expect(ms).toBeGreaterThanOrEqual(base);
        expect(ms).toBeLessThan(base + 1000);
      }
      expect(new Set(waits).size).toBeGreaterThan(1);
    },
  );
});
