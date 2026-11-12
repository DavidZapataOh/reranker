import { afterEach, expect, test, vi } from "vitest";
import { closeDatabases, database } from "./client.ts";

// Pools connect lazily, so building them needs valid variables but no reachable server.
const POOLED = "postgresql://reranker_app:x@ep-a-pooler.us-east-1.aws.neon.tech/neondb";

afterEach(async () => {
  await closeDatabases();
  vi.unstubAllEnvs();
});

test("builds one pool per role and reuses it", () => {
  vi.stubEnv("DATABASE_URL", POOLED);
  vi.stubEnv("DATABASE_URL_SYSTEM", POOLED);
  const app = database("app");
  expect(database("app")).toBe(app);
  expect(database("system")).not.toBe(app);
  expect(app.$client.options).toMatchObject({
    max: 5,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 2000,
  });
  expect(database("system").$client.options.max).toBe(3);
});

test("DB_POOL_MAX overrides both pool sizes and a closed pool is rebuilt on next use", async () => {
  vi.stubEnv("DATABASE_URL", POOLED);
  vi.stubEnv("DATABASE_URL_SYSTEM", POOLED);
  vi.stubEnv("DB_POOL_MAX", "1");
  const first = database("system");
  expect(first.$client.options.max).toBe(1);
  await closeDatabases();
  expect(first.$client.ending).toBe(true);
  expect(database("system")).not.toBe(first);
});

test("attaches the pool to Vercel Fluid compute when running on Vercel", () => {
  vi.stubEnv("DATABASE_URL", POOLED);
  vi.stubEnv("DATABASE_URL_SYSTEM", POOLED);
  vi.stubEnv("VERCEL", "1");
  expect(() => database("app")).not.toThrow();
});

test("an idle client error is logged instead of crashing the process", () => {
  vi.stubEnv("DATABASE_URL", POOLED);
  vi.stubEnv("DATABASE_URL_SYSTEM", POOLED);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  database("app").$client.emit("error", new Error("terminating connection"));
  expect(log).toHaveBeenCalledWith(
    'database pool "app": idle client error: terminating connection',
  );
  log.mockRestore();
});

test("refuses to build a pool without valid variables", () => {
  vi.stubEnv("DATABASE_URL", "");
  expect(() => database("app")).toThrow(/Invalid database environment/);
});
