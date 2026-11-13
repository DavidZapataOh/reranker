import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { appDb, appPool, endPools, systemDb, systemPool, verifiedTlsUrl } from "./client";

const attach = vi.hoisted(() => vi.fn());
vi.mock("@vercel/functions", () => ({ attachDatabasePool: attach }));

const neon = "postgresql://u:p@ep-a-pooler.us-east-1.aws.neon.tech/neondb";

test.each(["", "?sslmode=require", "?sslmode=prefer", "?sslmode=verify-ca", "?sslmode=disable"])(
  "pins Neon urls with %j to verify-full",
  (query) => {
    expect(new URL(verifiedTlsUrl(`${neon}${query}`)).searchParams.get("sslmode")).toBe(
      "verify-full",
    );
  },
);

test("drops libpq compatibility, under which require would skip certificate checks", () => {
  const url = new URL(verifiedTlsUrl(`${neon}?uselibpqcompat=true&sslmode=require`));
  expect(url.searchParams.get("uselibpqcompat")).toBeNull();
  expect(url.searchParams.get("sslmode")).toBe("verify-full");
});

test("keeps the channel binding and leaves a local Postgres untouched", () => {
  const pinned = new URL(verifiedTlsUrl(`${neon}?sslmode=require&channel_binding=require`));
  expect(pinned.searchParams.get("channel_binding")).toBe("require");
  const local = "postgresql://postgres:x@localhost:5432/reranker";
  expect(verifiedTlsUrl(local)).toBe(local);
});

describe("pools", () => {
  const app =
    "postgresql://reranker_app:x@ep-a-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";
  const system =
    "postgresql://reranker_system:x@ep-a-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", app);
    vi.stubEnv("DATABASE_URL_SYSTEM", system);
    vi.stubEnv("DB_POOL_MAX", undefined);
    vi.stubEnv("VERCEL", undefined);
  });

  afterEach(async () => {
    await endPools();
    vi.unstubAllEnvs();
    attach.mockClear();
  });

  test("are created once per role with the documented limits and verified TLS", () => {
    expect(appPool()).toBe(appPool());
    expect(appPool().options).toMatchObject({
      max: 5,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 2000,
    });
    expect(systemPool().options).toMatchObject({ max: 3 });
    expect(appPool().options.connectionString).toContain("reranker_app");
    expect(systemPool().options.connectionString).toContain("reranker_system");
    for (const pool of [appPool(), systemPool()]) {
      expect(new URL(pool.options.connectionString ?? "").searchParams.get("sslmode")).toBe(
        "verify-full",
      );
    }
    expect(appDb()).toBe(appDb());
    expect(systemDb()).not.toBe(appDb());
  });

  test("DB_POOL_MAX caps both pools", () => {
    vi.stubEnv("DB_POOL_MAX", "1");
    expect([appPool().options.max, systemPool().options.max]).toEqual([1, 1]);
  });

  test("only attach to Vercel when running there", () => {
    appPool();
    expect(attach).not.toHaveBeenCalled();
    vi.stubEnv("VERCEL", "1");
    expect(attach).toHaveBeenCalledTimes(0);
    systemPool();
    expect(attach).toHaveBeenCalledWith(systemPool());
  });

  test("an idle client error is logged without its message and does not throw", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(new Error("terminating connection for tenant data"), {
      code: "57P01",
    });
    expect(appPool().emit("error", error)).toBe(true);
    expect(log).toHaveBeenCalledWith("[db] idle app client error", { code: "57P01" });
    log.mockRestore();
  });

  test("endPools closes them so the next use opens new ones", async () => {
    const first = appPool();
    await endPools();
    expect(first.ended).toBe(true);
    expect(appPool()).not.toBe(first);
  });
});
