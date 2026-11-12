import { AppError } from "@reranker/schema";
import { sql } from "drizzle-orm";
import pg from "pg";
import { beforeEach, expect, test, vi } from "vitest";
import { asTenantId, withSystem, withTenant, withTenants } from "./tenancy.ts";

type Query = { text: string; values: unknown[] | undefined };

const state = vi.hoisted(() => ({
  queries: [] as Query[],
  released: [] as Array<Error | undefined>,
  failOn: undefined as ((text: string) => Error | undefined) | undefined,
  connectError: undefined as Error | undefined,
}));

vi.mock("./client.ts", () => ({
  getPool: () => ({
    connect: async () => {
      if (state.connectError) throw state.connectError;
      return {
        query: async (config: string | { text: string }, values?: unknown[]) => {
          const text = typeof config === "string" ? config : config.text;
          state.queries.push({ text, values });
          const failure = state.failOn?.(text);
          if (failure) throw failure;
          return { rows: [], rowCount: 0, fields: [], command: "SELECT" };
        },
        release: (error?: Error) => state.released.push(error),
      };
    },
  }),
}));

const A = asTenantId("0196f1c2-7a3b-7cde-8f01-23456789abcd");
const B = asTenantId("0196f1c2-7a3b-7cde-8f01-23456789abce");
const pgError = (code: string) => Object.assign(new pg.DatabaseError("boom", 0, "error"), { code });

beforeEach(() => {
  state.queries = [];
  state.released = [];
  state.failOn = undefined;
  state.connectError = undefined;
});

test("fixes the tenant in one statement right after begin and commits", async () => {
  const result = await withTenant(A, async (tx) => {
    await tx.execute(sql`select 1`);
    return "ok";
  });
  expect(result).toBe("ok");
  expect(state.queries.map((q) => q.text)).toEqual([
    "begin",
    "select set_config('app.tenant_ids', $1, true), set_config('statement_timeout', $2, true)",
    "select 1",
    "commit",
  ]);
  expect(state.queries[1]?.values).toEqual([`{${A}}`, "5000"]);
  expect(state.released).toEqual([undefined]);
});

test("withTenants passes every id and the options reach begin", async () => {
  await withTenants([A, B], async () => 1, {
    readOnly: true,
    isolation: "repeatable read",
    statementTimeoutMs: 200,
  });
  expect(state.queries[0]?.text).toBe("begin isolation level repeatable read read only");
  expect(state.queries[1]?.values).toEqual([`{${A},${B}}`, "200"]);
});

test("withSystem records the reason instead of tenant ids", async () => {
  await withSystem("auth.claim_free_reports", async () => 1, { readOnly: false });
  expect(state.queries[0]?.text).toBe("begin read write");
  expect(state.queries[1]?.text).toBe(
    "select set_config('app.system_reason', $1, true), set_config('statement_timeout', $2, true)",
  );
  expect(state.queries[1]?.values).toEqual(["auth.claim_free_reports", "5000"]);
});

test("an AppError from fn rolls back, keeps the connection and is rethrown as is", async () => {
  const error = new AppError("forbidden");
  await expect(
    withTenant(A, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(state.queries.at(-1)?.text).toBe("rollback");
  expect(state.released).toEqual([undefined]);
});

test("a statement error is translated and the healthy connection goes back to the pool", async () => {
  state.failOn = (text) => (text === "select 1" ? pgError("42501") : undefined);
  await expect(withTenant(A, (tx) => tx.execute(sql`select 1`))).rejects.toMatchObject({
    code: "internal",
  });
  expect(state.queries.at(-1)?.text).toBe("rollback");
  expect(state.released).toEqual([undefined]);
});

test("a failed rollback retires the connection", async () => {
  state.failOn = (text) => {
    if (text === "select 1") return pgError("57014");
    if (text === "rollback") return new Error("Connection terminated unexpectedly");
    return undefined;
  };
  await expect(withTenant(A, (tx) => tx.execute(sql`select 1`))).rejects.toMatchObject({
    code: "service_unavailable",
    retryAfterSeconds: 2,
  });
  expect(state.released).toHaveLength(1);
  expect(state.released[0]).toBeInstanceOf(Error);
});

test("an admin shutdown retires the connection", async () => {
  state.failOn = (text) => (text === "select 1" ? pgError("57P01") : undefined);
  await expect(withTenant(A, (tx) => tx.execute(sql`select 1`))).rejects.toMatchObject({
    code: "internal",
  });
  expect(state.released[0]).toBeInstanceOf(Error);
});

test("a pool that cannot hand out a client answers service_unavailable", async () => {
  state.connectError = new Error("timeout exceeded when trying to connect");
  await expect(withTenant(A, async () => 1)).rejects.toMatchObject({
    code: "service_unavailable",
    retryAfterSeconds: 2,
  });
  expect(state.queries).toEqual([]);
});
