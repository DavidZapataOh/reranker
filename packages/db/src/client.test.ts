import { afterEach, expect, test, vi } from "vitest";
import { closeDatabases, pool } from "./client.ts";

// Pools connect lazily, so building them needs valid variables but no reachable server.
const POOLED = "postgresql://reranker_app:x@ep-a-pooler.us-east-1.aws.neon.tech/neondb";

afterEach(async () => {
  await closeDatabases();
  vi.unstubAllEnvs();
});

function stubUrls() {
  vi.stubEnv("DATABASE_URL", POOLED);
  vi.stubEnv("DATABASE_URL_SYSTEM", POOLED);
}

test("builds one pool per role and reuses it", () => {
  stubUrls();
  const app = pool("app");
  expect(pool("app")).toBe(app);
  expect(pool("system")).not.toBe(app);
  expect(app.options).toMatchObject({
    max: 5,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 2000,
  });
  expect(pool("system").options.max).toBe(3);
});

test("DB_POOL_MAX overrides both pool sizes and a closed pool is rebuilt on next use", async () => {
  stubUrls();
  vi.stubEnv("DB_POOL_MAX", "1");
  const first = pool("system");
  expect(first.options.max).toBe(1);
  await closeDatabases();
  expect(first.ending).toBe(true);
  expect(pool("system")).not.toBe(first);
});

test("attaches the pool to Vercel Fluid compute when running on Vercel", () => {
  stubUrls();
  vi.stubEnv("VERCEL", "1");
  expect(() => pool("app")).not.toThrow();
});

test("an idle client error is logged instead of crashing the process", () => {
  stubUrls();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  pool("app").emit("error", new Error("terminating connection"));
  expect(log).toHaveBeenCalledWith(
    'database pool "app": idle client error: terminating connection',
  );
  log.mockRestore();
});

test("refuses to build a pool without valid variables", () => {
  vi.stubEnv("DATABASE_URL", "");
  expect(() => pool("app")).toThrow(/Invalid database environment/);
});
