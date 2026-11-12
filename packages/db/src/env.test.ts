import { describe, expect, test } from "vitest";
import { readDbEnv } from "./env.ts";

const pooled = (login: string) =>
  `postgresql://${login}:x@ep-a-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`;
const direct = (login: string) =>
  `postgresql://${login}:x@ep-a.us-east-1.aws.neon.tech/neondb?sslmode=require`;

describe("readDbEnv", () => {
  test("accepts pooled runtime urls and parses DB_POOL_MAX", () => {
    const env = readDbEnv({
      DATABASE_URL: pooled("reranker_app"),
      DATABASE_URL_SYSTEM: pooled("reranker_system"),
      DATABASE_URL_MIGRATIONS: direct("reranker_owner"),
      DB_POOL_MAX: "1",
    });
    expect(env).toEqual({
      DATABASE_URL: pooled("reranker_app"),
      DATABASE_URL_SYSTEM: pooled("reranker_system"),
      DATABASE_URL_MIGRATIONS: direct("reranker_owner"),
      DB_POOL_MAX: 1,
    });
  });

  test("leaves the optional variables undefined when absent or empty", () => {
    const env = readDbEnv({
      DATABASE_URL: pooled("reranker_app"),
      DATABASE_URL_SYSTEM: pooled("reranker_system"),
      DB_POOL_MAX: "",
    });
    expect(env.DB_POOL_MAX).toBeUndefined();
    expect(env.DATABASE_URL_MIGRATIONS).toBeUndefined();
  });

  test("rejects a runtime url that is not the Neon pooler host", () => {
    expect(() =>
      readDbEnv({ DATABASE_URL: direct("reranker_app"), DATABASE_URL_SYSTEM: pooled("s") }),
    ).toThrow(/DATABASE_URL must use the Neon -pooler host/);
    expect(() =>
      readDbEnv({ DATABASE_URL: pooled("a"), DATABASE_URL_SYSTEM: direct("reranker_system") }),
    ).toThrow(/DATABASE_URL_SYSTEM must use the Neon -pooler host/);
  });

  test("allows a local Postgres host for development", () => {
    const local = "postgresql://reranker_app:x@localhost:5432/reranker";
    expect(readDbEnv({ DATABASE_URL: local, DATABASE_URL_SYSTEM: local }).DATABASE_URL).toBe(local);
  });

  test.each(["0", "21", "abc", "1.5"])("rejects DB_POOL_MAX=%s", (value) => {
    expect(() =>
      readDbEnv({
        DATABASE_URL: pooled("a"),
        DATABASE_URL_SYSTEM: pooled("s"),
        DB_POOL_MAX: value,
      }),
    ).toThrow(/DB_POOL_MAX/);
  });

  test("rejects a missing DATABASE_URL_SYSTEM and a non-postgres url", () => {
    expect(() => readDbEnv({ DATABASE_URL: pooled("a") })).toThrow(/DATABASE_URL_SYSTEM/);
    expect(() =>
      readDbEnv({ DATABASE_URL: "https://example.com", DATABASE_URL_SYSTEM: pooled("s") }),
    ).toThrow(/DATABASE_URL must be a postgresql:\/\/ connection string/);
  });
});
