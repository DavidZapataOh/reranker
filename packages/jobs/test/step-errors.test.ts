import { CaptureChannelDisabledError, FlagsNotReadyError } from "@reranker/flags";
import { AppError } from "@reranker/schema";
import { describe, expect, test } from "vitest";
import { FatalError, RetryableError } from "workflow";
import {
  InvalidInputError,
  NON_RETRYABLE,
  NotFoundError,
  ProviderRejectedError,
  ProviderUnavailableError,
  QuotaExceededError,
  RateLimitedError,
  SpendCapExceededError,
} from "../src/errors";
import { toStepError } from "../src/step-errors";

function waitOf(e: Error, from: number) {
  return (e as RetryableError).retryAfter.getTime() - from;
}

test("rate limited maps to retryable after the exact delay", () => {
  const now = Date.now();
  const e = toStepError(new RateLimitedError(7000));
  expect(RetryableError.is(e)).toBe(true);
  expect(waitOf(e, now)).toBeGreaterThanOrEqual(6900);
  expect(waitOf(e, now)).toBeLessThanOrEqual(7100);
});

test("a provider that is down retries after the delay it gave", () => {
  const now = Date.now();
  const e = toStepError(new ProviderUnavailableError("dataforseo", 30_000));
  expect(RetryableError.is(e)).toBe(true);
  expect(waitOf(e, now)).toBeGreaterThanOrEqual(29_900);
  expect(waitOf(e, now)).toBeLessThanOrEqual(30_100);
});

test.each([
  new SpendCapExceededError("global", new Date()),
  new ProviderRejectedError("dataforseo", "40501"),
  new InvalidInputError("x"),
  new NotFoundError("x"),
  new CaptureChannelDisabledError(["capture-provider-openai"]),
  new AppError("not_found"),
])("%s is fatal", (err) => expect(FatalError.is(toStepError(err))).toBe(true));

test("the message keeps the error type for the panel", () => {
  expect(toStepError(new ProviderRejectedError("openai", "invalid_key")).message).toBe(
    "ProviderRejected: openai rejected the request (invalid_key)",
  );
  expect(toStepError(new RateLimitedError(10)).message).toMatch(/^RateLimited: /);
});

test("quota exceeded retries at the reset", () => {
  const resetsAt = new Date(Date.now() + 3_600_000);
  const e = toStepError(new QuotaExceededError("resend.emails", "normal", resetsAt));
  expect(RetryableError.is(e)).toBe(true);
  expect((e as RetryableError).retryAfter).toEqual(resetsAt);
});

describe("retryable platform errors", () => {
  test("a database that is unavailable waits the seconds it asks for", () => {
    const now = Date.now();
    const e = toStepError(new AppError("service_unavailable", { retryAfterSeconds: 2 }));
    expect(RetryableError.is(e)).toBe(true);
    expect(waitOf(e, now)).toBeGreaterThan(1500);
    expect(waitOf(e, now)).toBeLessThanOrEqual(2100);
  });

  test("flags that are not loaded retry after their own delay", () => {
    const now = Date.now();
    const e = toStepError(new FlagsNotReadyError());
    expect(RetryableError.is(e)).toBe(true);
    expect(waitOf(e, now)).toBeGreaterThan(29_000);
  });

  test("a retryable error with no wait keeps the default retry", () => {
    const e = new AppError("service_unavailable");
    const mapped = toStepError(e);
    expect(FatalError.is(mapped)).toBe(false);
    expect(mapped).toBe(e);
  });
});

test("unknown errors pass through so the SDK default retry applies", () => {
  const e = new Error("boom");
  expect(toStepError(e)).toBe(e);
});

test("a thrown value that is not an error is wrapped", () => {
  const mapped = toStepError("boom");
  expect(mapped).toBeInstanceOf(Error);
  expect(mapped.message).toBe("boom");
});

test("NON_RETRYABLE lists the fatal names", () => {
  expect(NON_RETRYABLE).toEqual([
    "ProviderRejected",
    "InvalidInput",
    "SpendCapExceeded",
    "NotFound",
    "CaptureChannelDisabled",
  ]);
});

test("domain error names are the catalog types", () => {
  expect([
    new RateLimitedError(1).name,
    new ProviderUnavailableError("xai", 1).name,
    new SpendCapExceededError("global", new Date()).name,
    new QuotaExceededError("q", "low", new Date()).name,
    new InvalidInputError("x").name,
    new NotFoundError("x").name,
  ]).toEqual([
    "RateLimited",
    "ProviderUnavailable",
    "SpendCapExceeded",
    "QuotaExceeded",
    "InvalidInput",
    "NotFound",
  ]);
});
