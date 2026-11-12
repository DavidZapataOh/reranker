import { AppError } from "@reranker/schema";
import { DrizzleQueryError } from "drizzle-orm/errors";
import pg from "pg";
import { afterEach, expect, test, vi } from "vitest";
import { toDbError } from "./errors.ts";
import { type DbEvent, setDbEventSink } from "./events.ts";

const pgError = (code: string) => Object.assign(new pg.DatabaseError("boom", 0, "error"), { code });

afterEach(() => setDbEventSink(null));

test.each([
  ["57014", pgError("57014"), "timeout", undefined],
  ["23505", pgError("23505"), "conflict", undefined],
  ["42501", pgError("42501"), "internal", undefined],
  ["23503", pgError("23503"), "internal", undefined],
  ["25006", pgError("25006"), "internal", undefined],
  ["53300", pgError("53300"), "service_unavailable", 30],
  ["57P03", pgError("57P03"), "service_unavailable", 30],
  ["pool timeout", new Error("timeout exceeded when trying to connect"), "service_unavailable", 2],
  ["connection lost", new Error("Connection terminated unexpectedly"), "service_unavailable", 2],
  [
    "ECONNREFUSED",
    Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    "service_unavailable",
    2,
  ],
])("maps %s", (_label, input, code, retryAfterSeconds) => {
  const out = toDbError(input, { pool: "app" }) as AppError;
  expect(out).toBeInstanceOf(AppError);
  expect(out.code).toBe(code);
  expect(out.retryAfterSeconds).toBe(retryAfterSeconds);
  expect(out.cause).toBe(input);
});

test("unwraps Drizzle query errors and keeps the driver error, not the query parameters, as cause", () => {
  const driver = pgError("23505");
  const wrapped = new DrizzleQueryError("insert into x values ($1)", ["secret"], driver);
  const out = toDbError(wrapped, { pool: "system" }) as AppError;
  expect(out.code).toBe("conflict");
  expect(out.cause).toBe(driver);
  expect(out.message).not.toContain("secret");
});

test("passes AppError and unknown errors through unchanged", () => {
  const app = new AppError("forbidden");
  expect(toDbError(app, { pool: "app" })).toBe(app);
  const plain = new TypeError("bug");
  expect(toDbError(plain, { pool: "app" })).toBe(plain);
  const nodeError = Object.assign(new Error("x"), { code: "ERR_INVALID_ARG_TYPE" });
  expect(toDbError(nodeError, { pool: "app" })).toBe(nodeError);
  expect(toDbError("string", { pool: "app" })).toBe("string");
});

test("emits db_rls_violation on 42501 and db_compute_unavailable on 53300/57P03", () => {
  const events: DbEvent[] = [];
  setDbEventSink((event) => events.push(event));
  toDbError(pgError("42501"), { pool: "system", reason: "jobs.lease" });
  toDbError(pgError("53300"), { pool: "app" });
  toDbError(pgError("57P03"), { pool: "app" });
  toDbError(pgError("23505"), { pool: "app" });
  expect(events).toEqual([
    { name: "db_rls_violation", pool: "system", pgCode: "42501", reason: "jobs.lease" },
    { name: "db_compute_unavailable", pool: "app", pgCode: "53300" },
    { name: "db_compute_unavailable", pool: "app", pgCode: "57P03" },
  ]);
});

test("pool timeouts feed db_pool_exhausted, refused connections do not", () => {
  vi.useFakeTimers();
  try {
    const events: DbEvent[] = [];
    setDbEventSink((event) => events.push(event));
    for (let i = 0; i < 6; i++) {
      toDbError(new Error("timeout exceeded when trying to connect"), { pool: "app" });
      toDbError(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), { pool: "app" });
    }
    expect(events).toEqual([{ name: "db_pool_exhausted", pool: "app" }]);
  } finally {
    vi.useRealTimers();
  }
});
