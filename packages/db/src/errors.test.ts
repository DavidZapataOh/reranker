import { AppError } from "@reranker/schema";
import { DrizzleQueryError } from "drizzle-orm";
import pg from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";
import { toDbError } from "./errors";
import { type DbEvent, resetDbEventsForTest, setDbEventSink } from "./events";

function pgError(code: string): pg.DatabaseError {
  const err = new pg.DatabaseError("sensitive: relation app.reports", 0, "error");
  err.code = code;
  return err;
}

afterEach(resetDbEventsForTest);

describe("toDbError", () => {
  test.each([
    [pgError("57014"), "timeout", undefined],
    [pgError("23505"), "conflict", undefined],
    [pgError("42501"), "internal", undefined],
    [pgError("23503"), "internal", undefined],
    [pgError("53300"), "service_unavailable", 30],
    [pgError("57P03"), "service_unavailable", 30],
    [pgError("08006"), "service_unavailable", 2],
    [pgError("57P01"), "service_unavailable", 2],
    [Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), "service_unavailable", 2],
    [new Error("timeout exceeded when trying to connect"), "service_unavailable", 2],
    [
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      "service_unavailable",
      2,
    ],
  ])("maps %s to %s", (input, code, retryAfterSeconds) => {
    const out = toDbError(input, { pool: "app" }) as AppError;
    expect(out).toBeInstanceOf(AppError);
    expect(out.code).toBe(code);
    expect(out.retryAfterSeconds).toBe(retryAfterSeconds);
    expect(out.cause).toBe(input);
  });

  test("keeps driver detail out of the error message", () => {
    const out = toDbError(pgError("42501"), { pool: "app" }) as AppError;
    expect(out.message).not.toContain("relation");
  });

  test("passes AppError and unknown errors through unchanged", () => {
    const app = new AppError("not_found");
    const plain = new Error("boom");
    expect(toDbError(app, { pool: "app" })).toBe(app);
    expect(toDbError(plain, { pool: "app" })).toBe(plain);
    expect(toDbError("text", { pool: "app" })).toBe("text");
  });

  test("translates a plain error that only borrows the AppError name", () => {
    const impostor = Object.assign(new Error("boom"), { name: "AppError", code: "ECONNRESET" });
    const out = toDbError(impostor, { pool: "app" }) as AppError;
    expect(out).not.toBe(impostor);
    expect(out.code).toBe("service_unavailable");
  });

  test("unwraps the query error drizzle wraps around driver errors", () => {
    const driver = pgError("23505");
    const wrapped = new DrizzleQueryError("insert into app.reports", ["secret"], driver);
    const out = toDbError(wrapped, { pool: "app" }) as AppError;
    expect(out.code).toBe("conflict");
    expect(out.cause).toBe(driver);
    const network = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(
      toDbError(new DrizzleQueryError("select 1", [], network), { pool: "app" }),
    ).toMatchObject({ code: "service_unavailable" });
  });

  test("hides the SQL of a drizzle query error whose cause is unknown", () => {
    const inner = new Error("boom");
    const wrapped = new DrizzleQueryError("select secret from app.reports", ["p1"], inner);
    const out = toDbError(wrapped, { pool: "app" }) as AppError;
    expect(out).toBeInstanceOf(AppError);
    expect(out.code).toBe("internal");
    expect(out.cause).toBe(inner);
    expect(out.message).not.toContain("secret");
  });

  test("keeps an AppError that a drizzle query error wraps", () => {
    const inner = new AppError("internal");
    expect(toDbError(new DrizzleQueryError("select 1", [], inner), { pool: "app" })).toBe(inner);
  });

  test.each(["Connection terminated unexpectedly", "Connection terminated"])(
    "maps the code-less driver error %j to service_unavailable",
    (message) => {
      expect(toDbError(new Error(message), { pool: "app" })).toMatchObject({
        code: "service_unavailable",
        retryAfterSeconds: 2,
      });
    },
  );

  test("emits db_rls_violation on 42501 and db_compute_unavailable on 53300/57P03", () => {
    const sink = vi.fn<(e: DbEvent) => void>();
    setDbEventSink(sink);
    toDbError(pgError("42501"), { pool: "app" });
    toDbError(pgError("53300"), { pool: "system", reason: "jobs.lease" });
    toDbError(pgError("57P03"), { pool: "app" });
    expect(sink.mock.calls.map(([e]) => e)).toEqual([
      { name: "db_rls_violation", pool: "app", pgCode: "42501" },
      { name: "db_compute_unavailable", pool: "system", pgCode: "53300", reason: "jobs.lease" },
      { name: "db_compute_unavailable", pool: "app", pgCode: "57P03" },
    ]);
  });
});
