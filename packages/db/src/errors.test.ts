import { AppError } from "@reranker/schema";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { DatabaseError } from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";
import { toDbError } from "./errors.ts";
import { setDbEventSink } from "./events.ts";

function pgError(code: string): DatabaseError {
  const error = new DatabaseError(`pg ${code}`, 0, "error");
  error.code = code;
  return error;
}

afterEach(() => {
  setDbEventSink(null);
});

describe("toDbError", () => {
  test.each([
    ["57014", "timeout", undefined],
    ["23505", "conflict", undefined],
    ["42501", "internal", undefined],
    ["23503", "internal", undefined],
    ["25006", "internal", undefined],
    ["53300", "service_unavailable", 30],
    ["57P03", "service_unavailable", 30],
  ])("maps postgres %s to %s", (code, appCode, retryAfterSeconds) => {
    const input = pgError(code);
    const out = toDbError(input, { pool: "app" }) as AppError;
    expect(out).toBeInstanceOf(AppError);
    expect(out.code).toBe(appCode);
    expect(out.retryAfterSeconds).toBe(retryAfterSeconds);
    expect(out.cause).toBe(input);
  });

  test.each([
    [new Error("timeout exceeded when trying to connect")],
    [new Error("Connection terminated due to connection timeout")],
    [new Error("Connection terminated unexpectedly")],
    [Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" })],
    [Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
  ])("maps %s to service_unavailable with a 2 s retry", (input) => {
    const out = toDbError(input, { pool: "system" }) as AppError;
    expect(out).toMatchObject({ code: "service_unavailable", retryAfterSeconds: 2 });
    expect(out.cause).toBe(input);
  });

  test("unwraps drizzle's query error and keeps the query text and params out of the result", () => {
    const pg = pgError("23505");
    const wrapped = new DrizzleQueryError("insert into app.x values ($1)", ["secret"], pg);
    const out = toDbError(wrapped, { pool: "app" }) as AppError;
    expect(out.code).toBe("conflict");
    expect(out.cause).toBe(pg);
    expect(out.message).not.toMatch(/insert|secret/);
  });

  test("unwraps drizzle's query error around a pool timeout", () => {
    const timeout = new Error("timeout exceeded when trying to connect");
    const out = toDbError(new DrizzleQueryError("select 1", [], timeout), { pool: "app" });
    expect(out).toMatchObject({
      code: "service_unavailable",
      retryAfterSeconds: 2,
      cause: timeout,
    });
  });

  test("passes AppError and unrelated errors through as the same reference", () => {
    const app = new AppError("not_found");
    const other = new TypeError("bug");
    expect(toDbError(app, { pool: "app" })).toBe(app);
    expect(toDbError(other, { pool: "app" })).toBe(other);
    expect(toDbError("text", { pool: "app" })).toBe("text");
  });

  test("emits db_rls_violation with the system reason, and compute and pool events", () => {
    const sink = vi.fn();
    setDbEventSink(sink);
    toDbError(pgError("42501"), { pool: "system", reason: "auth.claim_free_reports" });
    toDbError(pgError("57P03"), { pool: "app" });
    toDbError(pgError("23505"), { pool: "app" });
    expect(sink.mock.calls).toEqual([
      [
        {
          name: "db_rls_violation",
          pool: "system",
          pgCode: "42501",
          reason: "auth.claim_free_reports",
        },
      ],
      [{ name: "db_compute_unavailable", pool: "app", pgCode: "57P03" }],
    ]);
  });
});
