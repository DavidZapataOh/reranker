import { InvalidInputError, RateLimitedError, SpendCapExceededError } from "@reranker/jobs/errors";
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { afterEach, expect, test, vi } from "vitest";
import { mapOpenAIError } from "../../src/openai/errors";

afterEach(() => vi.useRealTimers());

// Built the way the SDK builds them from an HTTP error response.
const apiError = (
  status: number,
  headers: Record<string, string> = {},
  error: { code?: string; type?: string; param?: string } = {},
) =>
  APIError.generate(
    status,
    { error: { message: "¿Qué odontólogo…", ...error } },
    undefined,
    new Headers(headers),
  );

test.each([
  ["429 with retry-after", apiError(429, { "retry-after": "3" }), 3000],
  ["429 with retry-after-ms", apiError(429, { "retry-after-ms": "250" }), 250],
  ["429 with a request reset", apiError(429, { "x-ratelimit-reset-requests": "1.5s" }), 1500],
  [
    "429 with both resets",
    apiError(429, { "x-ratelimit-reset-requests": "20ms", "x-ratelimit-reset-tokens": "6m0s" }),
    360_000,
  ],
  ["429 without hints", apiError(429), 5000],
])("%s waits as told and is retried", (_, err, wait) => {
  const m = mapOpenAIError(err);
  expect(m).toMatchObject({ retryable: true, breakerFailure: false });
  expect(m.alert).toBeUndefined();
  expect(m.error).toBeInstanceOf(RateLimitedError);
  expect((m.error as RateLimitedError).retryAfterMs).toBe(wait);
});

test("insufficient_quota is a spend cap with an alert, never retried", () => {
  vi.useFakeTimers({ now: new Date("2026-11-20T15:00:00Z") });
  const m = mapOpenAIError(apiError(429, {}, { code: "insufficient_quota" }));
  expect(m).toMatchObject({ retryable: false, breakerFailure: false, alert: "quota" });
  expect(m.error).toBeInstanceOf(SpendCapExceededError);
  expect(m.error.name).toBe("SpendCapExceeded");
  expect((m.error as SpendCapExceededError).resetsAt.getTime()).toBeGreaterThan(Date.now());
});

test.each([
  ["400", apiError(400, {}, { code: "invalid_value", param: "input" }), "invalid_value", undefined],
  ["422", apiError(422), "http_422", undefined],
  ["401", apiError(401, {}, { code: "invalid_api_key" }), "invalid_api_key", "rejected"],
  ["403", apiError(403), "http_403", "rejected"],
  [
    "404 retired model",
    apiError(404, {}, { code: "model_not_found" }),
    "model_not_found",
    "rejected",
  ],
  ["400 on the model", apiError(400, {}, { param: "model" }), "http_400", "rejected"],
  ["400 on the tool", apiError(400, {}, { param: "tools[0].type" }), "http_400", "rejected"],
])("%s is rejected without retry", (_, err, code, alert) => {
  const m = mapOpenAIError(err);
  expect(m).toMatchObject({ retryable: false, breakerFailure: false });
  expect(m.alert).toBe(alert);
  expect(m.error.name).toBe("ProviderRejected");
  expect(m.error.message).toContain(code);
  // Error bodies can echo the prompt; only codes leave them.
  expect(m.error.message).not.toContain("odontólogo");
});

test.each([
  ["503", apiError(503, { "retry-after": "2" })],
  ["500", apiError(500)],
  ["timeout", new APIConnectionTimeoutError()],
  ["connection", new APIConnectionError({ message: "fetch failed" })],
  ["our own fetch timeout", new DOMException("The operation timed out.", "TimeoutError")],
])("%s is retried and counts against the breaker", (_, err) => {
  const m = mapOpenAIError(err);
  expect(m).toMatchObject({ retryable: true, breakerFailure: true });
  expect(m.error.name).toBe("ProviderUnavailable");
});

test("a 503 waits as long as OpenAI asks", () =>
  expect(mapOpenAIError(apiError(503, { "retry-after": "2" })).error).toMatchObject({
    retryAfterMs: 2000,
  }));

test("a retry-after date waits until then", () => {
  vi.useFakeTimers({ now: new Date("2026-11-20T15:00:00Z") });
  const m = mapOpenAIError(apiError(429, { "retry-after": "Fri, 20 Nov 2026 15:00:07 GMT" }));
  expect((m.error as RateLimitedError).retryAfterMs).toBe(7000);
});

test("a garbled reset header falls back to the default wait", () =>
  expect(
    (
      mapOpenAIError(apiError(429, { "x-ratelimit-reset-requests": "soon" }))
        .error as RateLimitedError
    ).retryAfterMs,
  ).toBe(5000));

test.each([408, 409])("%i is retried without blaming the breaker", (status) =>
  expect(mapOpenAIError(apiError(status))).toMatchObject({
    retryable: true,
    breakerFailure: false,
  }),
);

test("a call the step aborted is retried without blaming the breaker", () =>
  expect(mapOpenAIError(new APIUserAbortError())).toMatchObject({
    retryable: true,
    breakerFailure: false,
  }));

test("anything thrown that is not an Error becomes one and is not retried", () => {
  const m = mapOpenAIError("boom");
  expect(m).toMatchObject({ retryable: false, breakerFailure: false });
  expect(m.error.message).toBe("boom");
});

test("a domain error, such as a profile drift, keeps its own class and is not retried", () => {
  const drift = new InvalidInputError("profile drifted");
  expect(mapOpenAIError(drift)).toEqual({ error: drift, retryable: false, breakerFailure: false });
});
