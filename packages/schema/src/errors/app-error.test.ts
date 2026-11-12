import { describe, expect, test } from "vitest";
import { AppError, isAppError } from "./app-error.ts";
import { ERROR_CODES, ERRORS } from "./catalog.ts";

describe("ERRORS", () => {
  test("holds the 21 published codes", () => {
    expect(ERROR_CODES).toHaveLength(21);
  });

  test("every retryable code has a positive default retry delay and no other code has one", () => {
    for (const code of ERROR_CODES) {
      const spec: { retryable: boolean; retryAfterSeconds?: number } = ERRORS[code];
      if (spec.retryable) expect(spec.retryAfterSeconds).toBeGreaterThan(0);
      else expect(spec.retryAfterSeconds).toBeUndefined();
    }
  });
});

describe("AppError", () => {
  test("takes status and retryable from the catalog", () => {
    const error = new AppError("service_unavailable", { retryAfterSeconds: 2 });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "AppError",
      code: "service_unavailable",
      status: 503,
      retryable: true,
      retryAfterSeconds: 2,
      message: "service_unavailable",
    });
  });

  test("keeps the detail in the message and the cause for logs", () => {
    const cause = new Error("pg 23505");
    const error = new AppError("conflict", { detail: "pg 23505", cause });
    expect(error.message).toBe("conflict: pg 23505");
    expect(error.cause).toBe(cause);
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  test("has no cause property when none is given", () => {
    expect("cause" in new AppError("internal")).toBe(false);
  });

  test("carries params and field errors", () => {
    const error = new AppError("validation_failed", {
      params: { field: "email" },
      fieldErrors: [{ pointer: "/body/email", code: "invalid_format" }],
    });
    expect(error.params).toEqual({ field: "email" });
    expect(error.fieldErrors).toEqual([{ pointer: "/body/email", code: "invalid_format" }]);
  });
});

describe("isAppError", () => {
  test("recognizes instances and copies from another module instance by brand", () => {
    expect(isAppError(new AppError("internal"))).toBe(true);
    const foreign = Object.assign(new Error("x"), { [Symbol.for("reranker.app_error")]: true });
    expect(isAppError(foreign)).toBe(true);
  });

  test.each([new Error("x"), null, undefined, "internal", { code: "internal" }])(
    "rejects %s",
    (value) => {
      expect(isAppError(value)).toBe(false);
    },
  );
});
