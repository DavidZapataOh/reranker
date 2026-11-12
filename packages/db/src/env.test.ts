import { expect, test } from "vitest";
import { readDbEnv } from "./env.ts";

const POOLED_APP =
  "postgresql://reranker_app:x@ep-a-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";
const POOLED_SYSTEM =
  "postgresql://reranker_system:x@ep-a-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";
const DIRECT_OWNER =
  "postgresql://reranker_owner:x@ep-a.us-east-1.aws.neon.tech/neondb?sslmode=require";

test("accepts pooled runtime urls and parses DB_POOL_MAX", () => {
  const env = readDbEnv({
    DATABASE_URL: POOLED_APP,
    DATABASE_URL_SYSTEM: POOLED_SYSTEM,
    DB_POOL_MAX: "1",
  });
  expect(env).toEqual({
    DATABASE_URL: POOLED_APP,
    DATABASE_URL_SYSTEM: POOLED_SYSTEM,
    DB_POOL_MAX: 1,
  });
});

test("accepts a direct migrations url and leaves DB_POOL_MAX unset by default", () => {
  const env = readDbEnv({
    DATABASE_URL: POOLED_APP,
    DATABASE_URL_SYSTEM: POOLED_SYSTEM,
    DATABASE_URL_MIGRATIONS: DIRECT_OWNER,
  });
  expect(env.DATABASE_URL_MIGRATIONS).toBe(DIRECT_OWNER);
  expect(env.DB_POOL_MAX).toBeUndefined();
});

test("allows a local Postgres outside Neon", () => {
  const local = "postgres://reranker_app:x@localhost:5432/reranker";
  expect(readDbEnv({ DATABASE_URL: local, DATABASE_URL_SYSTEM: local }).DATABASE_URL).toBe(local);
});

test.each([
  ["DATABASE_URL", { DATABASE_URL: DIRECT_OWNER, DATABASE_URL_SYSTEM: POOLED_SYSTEM }],
  ["DATABASE_URL_SYSTEM", { DATABASE_URL: POOLED_APP, DATABASE_URL_SYSTEM: DIRECT_OWNER }],
])("rejects a Neon %s that is not the pooler host", (name, source) => {
  expect(() => readDbEnv(source)).toThrow(new RegExp(`${name}: .*pooler`));
});

test.each(["0", "21", "abc", "1.5", ""])("rejects DB_POOL_MAX=%j", (value) => {
  expect(() =>
    readDbEnv({ DATABASE_URL: POOLED_APP, DATABASE_URL_SYSTEM: POOLED_SYSTEM, DB_POOL_MAX: value }),
  ).toThrow(/DB_POOL_MAX/);
});

test("rejects a missing DATABASE_URL_SYSTEM and a url that is not postgres", () => {
  expect(() => readDbEnv({ DATABASE_URL: POOLED_APP })).toThrow(/DATABASE_URL_SYSTEM/);
  expect(() =>
    readDbEnv({ DATABASE_URL: "https://example.com", DATABASE_URL_SYSTEM: POOLED_SYSTEM }),
  ).toThrow(/DATABASE_URL:/);
});

test("never echoes the connection string in the error", () => {
  expect(() =>
    readDbEnv({ DATABASE_URL: DIRECT_OWNER, DATABASE_URL_SYSTEM: POOLED_SYSTEM }),
  ).not.toThrow(/reranker_owner:x/);
});
