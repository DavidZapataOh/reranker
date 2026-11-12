import { expect, test } from "vitest";
import { AppError, ERROR_CODES, ERRORS, isAppError, Uuid } from "../src/index.ts";

test("every retryable code declares a default retry delay", () => {
  const retryable = ERROR_CODES.filter((code) => ERRORS[code].retryable);
  expect(retryable.length).toBeGreaterThan(0);
  for (const code of retryable) {
    const entry = ERRORS[code];
    expect("retryAfterSeconds" in entry && entry.retryAfterSeconds, code).toBeGreaterThan(0);
  }
});

test("AppError carries code, status, retryability and the cause", () => {
  const cause = new Error("pg");
  const error = new AppError("service_unavailable", { retryAfterSeconds: 2, cause });
  expect(error).toMatchObject({
    name: "AppError",
    code: "service_unavailable",
    status: 503,
    retryable: true,
    retryAfterSeconds: 2,
    message: "service_unavailable",
  });
  expect(error.cause).toBe(cause);
});

test("detail only goes to the message", () => {
  const error = new AppError("internal", { detail: "rls violation" });
  expect(error.message).toBe("internal: rls violation");
  expect(error.retryAfterSeconds).toBeUndefined();
});

test("isAppError recognizes instances and copies from another module instance", () => {
  expect(isAppError(new AppError("conflict"))).toBe(true);
  const foreign = Object.assign(new Error("x"), { [Symbol.for("reranker.app_error")]: true });
  expect(isAppError(foreign)).toBe(true);
  expect(isAppError(new Error("x"))).toBe(false);
  expect(isAppError(null)).toBe(false);
  expect(isAppError("internal")).toBe(false);
});

test("Uuid accepts canonical uuids only", () => {
  expect(Uuid.safeParse("0196f1c2-7a3b-7cde-8f01-23456789abcd").success).toBe(true);
  expect(Uuid.safeParse("not-a-uuid").success).toBe(false);
});
