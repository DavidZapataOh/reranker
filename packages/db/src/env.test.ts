import { expect, test } from "vitest";
import { readDbEnv } from "./env";

const pooledApp =
  "postgresql://reranker_app:x@ep-a-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";
const pooledSystem =
  "postgresql://reranker_system:x@ep-a-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";

test("accepts pooled runtime urls and parses DB_POOL_MAX", () => {
  const env = readDbEnv({
    DATABASE_URL: pooledApp,
    DATABASE_URL_SYSTEM: pooledSystem,
    DB_POOL_MAX: "1",
  });
  expect(env.DB_POOL_MAX).toBe(1);
  expect(env.DATABASE_URL_MIGRATIONS).toBeUndefined();
});

test("leaves DB_POOL_MAX undefined when unset", () => {
  const env = readDbEnv({ DATABASE_URL: pooledApp, DATABASE_URL_SYSTEM: pooledSystem });
  expect(env.DB_POOL_MAX).toBeUndefined();
});

test("rejects a runtime url that is not the pooler host", () => {
  expect(() =>
    readDbEnv({
      DATABASE_URL: "postgresql://u:x@ep-a.us-east-1.aws.neon.tech/neondb",
      DATABASE_URL_SYSTEM: pooledSystem,
    }),
  ).toThrow(/DATABASE_URL.*pooler/);
  expect(() =>
    readDbEnv({
      DATABASE_URL: pooledApp,
      DATABASE_URL_SYSTEM: "postgresql://u:x@ep-a.us-east-1.aws.neon.tech/neondb",
    }),
  ).toThrow(/DATABASE_URL_SYSTEM.*pooler/);
});

test("allows a local Postgres host", () => {
  const local = "postgresql://postgres:x@localhost:5432/reranker";
  expect(readDbEnv({ DATABASE_URL: local, DATABASE_URL_SYSTEM: local }).DATABASE_URL).toBe(local);
});

test("accepts a direct migrations url", () => {
  const direct = "postgresql://reranker_owner:x@ep-a.us-east-1.aws.neon.tech/neondb";
  const env = readDbEnv({
    DATABASE_URL: pooledApp,
    DATABASE_URL_SYSTEM: pooledSystem,
    DATABASE_URL_MIGRATIONS: direct,
  });
  expect(env.DATABASE_URL_MIGRATIONS).toBe(direct);
});

test.each(["0", "21", "abc", "1.5", ""])("rejects DB_POOL_MAX %j", (value) => {
  expect(() =>
    readDbEnv({ DATABASE_URL: pooledApp, DATABASE_URL_SYSTEM: pooledSystem, DB_POOL_MAX: value }),
  ).toThrow(/DB_POOL_MAX/);
});

test("rejects a missing DATABASE_URL_SYSTEM or a non-postgres url", () => {
  expect(() => readDbEnv({ DATABASE_URL: pooledApp })).toThrow(/DATABASE_URL_SYSTEM/);
  expect(() =>
    readDbEnv({ DATABASE_URL: "https://example.com", DATABASE_URL_SYSTEM: pooledSystem }),
  ).toThrow(/DATABASE_URL/);
});

test("rejects a migrations url on the pooler host", () => {
  expect(() =>
    readDbEnv({
      DATABASE_URL: pooledApp,
      DATABASE_URL_SYSTEM: pooledSystem,
      DATABASE_URL_MIGRATIONS:
        "postgresql://reranker_owner:x@ep-a-pooler.us-east-1.aws.neon.tech/neondb",
    }),
  ).toThrow(/DATABASE_URL_MIGRATIONS: must use the direct host, not the pooler/);
});
