import { DrizzleQueryError } from "drizzle-orm/errors";
import { DatabaseError } from "pg";
import { afterEach, describe, expect, test } from "vitest";
import { AppError, isAppError } from "./app-error.ts";
import { pgCodeOf, toDbError } from "./errors.ts";
import { type DbEvent, setDbEventSink } from "./events.ts";

function pgError(code: string): DatabaseError {
  const error = new DatabaseError(`pg ${code}`, 0, "error");
  error.code = code;
  return error;
}

describe("toDbError", () => {
  afterEach(() => setDbEventSink(null));

  test.each([
    ["57014", pgError("57014"), "timeout", undefined],
    ["23505", pgError("23505"), "conflict", undefined],
    ["42501", pgError("42501"), "internal", undefined],
    ["23503", pgError("23503"), "internal", undefined],
    ["25006", pgError("25006"), "internal", undefined],
    ["53300", pgError("53300"), "service_unavailable", 30],
    ["57P03", pgError("57P03"), "service_unavailable", 30],
    [
      "pool timeout",
      new Error("timeout exceeded when trying to connect"),
      "service_unavailable",
      2,
    ],
    [
      "connect timeout",
      new Error("Connection terminated due to connection timeout"),
      "service_unavailable",
      2,
    ],
    [
      "ECONNREFUSED",
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      "service_unavailable",
      2,
    ],
  ])("maps %s to %s", (_label, input, code, retryAfterSeconds) => {
    const out = toDbError(input, { pool: "app" });
    expect(isAppError(out)).toBe(true);
    expect(out).toMatchObject({ code, retryAfterSeconds, cause: input });
  });

  test("finds the SQLSTATE inside a drizzle query error", () => {
    const wrapped = new DrizzleQueryError("select 1", [], pgError("23505"));
    expect(pgCodeOf(wrapped)).toBe("23505");
    expect(toDbError(wrapped, { pool: "system" })).toMatchObject({ code: "conflict" });
  });

  test("passes AppError and unrelated errors through unchanged", () => {
    const appError = new AppError("internal");
    const plain = new Error("boom");
    expect(toDbError(appError, { pool: "app" })).toBe(appError);
    expect(toDbError(plain, { pool: "app" })).toBe(plain);
    expect(toDbError("text", { pool: "app" })).toBe("text");
  });

  test("emits db_rls_violation on 42501 and db_compute_unavailable on 53300/57P03", () => {
    const seen: DbEvent[] = [];
    setDbEventSink((event) => seen.push(event));
    toDbError(pgError("42501"), { pool: "app", reason: "tenant" });
    toDbError(pgError("53300"), { pool: "system" });
    toDbError(pgError("57P03"), { pool: "app" });
    toDbError(pgError("23505"), { pool: "app" });
    expect(seen).toEqual([
      { name: "db_rls_violation", pool: "app", pgCode: "42501", reason: "tenant" },
      { name: "db_compute_unavailable", pool: "system", pgCode: "53300" },
      { name: "db_compute_unavailable", pool: "app", pgCode: "57P03" },
    ]);
  });

  test("AppError carries the brand that survives a second copy of the module", () => {
    const foreign = Object.assign(new Error("x"), {
      [Symbol.for("reranker.app_error")]: true,
    });
    expect(isAppError(foreign)).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
    expect(new AppError("timeout", { detail: "slow" }).message).toBe("timeout: slow");
  });
});
