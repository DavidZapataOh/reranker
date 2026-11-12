import { expect, test } from "vitest";
import { readDbEnv } from "./env.ts";

const pooled = (user: string) =>
  `postgresql://${user}:x@ep-a-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`;

test("accepts pooled runtime urls and parses DB_POOL_MAX", () => {
  const env = readDbEnv({
    DATABASE_URL: pooled("reranker_app"),
    DATABASE_URL_SYSTEM: pooled("reranker_system"),
    DB_POOL_MAX: "1",
  });
  expect(env.DB_POOL_MAX).toBe(1);
  expect(env.DATABASE_URL_MIGRATIONS).toBeUndefined();
});

test("accepts a direct migrations url and local Postgres for runtime", () => {
  const env = readDbEnv({
    DATABASE_URL: "postgresql://reranker_app:x@localhost:5432/reranker",
    DATABASE_URL_SYSTEM: "postgresql://reranker_system:x@localhost:5432/reranker",
    DATABASE_URL_MIGRATIONS: "postgresql://owner:x@ep-a.us-east-1.aws.neon.tech/neondb",
  });
  expect(env.DB_POOL_MAX).toBeUndefined();
});

test("rejects a runtime url that is not the pooler host", () => {
  expect(() =>
    readDbEnv({
      DATABASE_URL: "postgresql://u:x@ep-a.us-east-1.aws.neon.tech/neondb",
      DATABASE_URL_SYSTEM: pooled("reranker_system"),
    }),
  ).toThrow(/DATABASE_URL.*pooler/);
});

test.each(["0", "21", "abc", "1.5"])("rejects DB_POOL_MAX=%s", (value) => {
  expect(() =>
    readDbEnv({
      DATABASE_URL: pooled("reranker_app"),
      DATABASE_URL_SYSTEM: pooled("reranker_system"),
      DB_POOL_MAX: value,
    }),
  ).toThrow(/DB_POOL_MAX/);
});

test("rejects a missing DATABASE_URL_SYSTEM without echoing the other values", () => {
  const error = (() => {
    try {
      readDbEnv({ DATABASE_URL: pooled("reranker_app") });
    } catch (caught) {
      return caught as Error;
    }
  })();
  expect(error?.message).toMatch(/DATABASE_URL_SYSTEM/);
  expect(error?.message).not.toContain("reranker_app:x");
});
