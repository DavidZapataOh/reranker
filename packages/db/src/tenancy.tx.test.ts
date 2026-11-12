import { randomUUID } from "node:crypto";
import { AppError } from "@reranker/schema";
import type { SQL } from "drizzle-orm";
import { PgDialect, type PgTransactionConfig } from "drizzle-orm/pg-core";
import { DatabaseError } from "pg";
import { beforeEach, expect, test, vi } from "vitest";

// The real transaction path runs in test/tenancy.int.test.ts against Neon; this double only
// records what tenancy.ts asks of drizzle, to pin the statements and the error mapping.
const calls: { pool: string; config: PgTransactionConfig | undefined; queries: unknown[] }[] = [];
let failWith: unknown;

vi.mock("./client.ts", () => ({
  database: (pool: string) => ({
    async transaction(body: (tx: unknown) => Promise<unknown>, config?: PgTransactionConfig) {
      const call = { pool, config, queries: [] as unknown[] };
      calls.push(call);
      const dialect = new PgDialect();
      const tx = {
        execute: async (query: SQL) => {
          const { sql, params } = dialect.sqlToQuery(query);
          call.queries.push({ sql, params });
          if (failWith !== undefined) throw failWith;
          return { rows: [] };
        },
      };
      return body(tx);
    },
  }),
}));

const { asTenantId, withSystem, withTenant, withTenants } = await import("./tenancy.ts");

const A = asTenantId(randomUUID());
const B = asTenantId(randomUUID());

beforeEach(() => {
  calls.length = 0;
  failWith = undefined;
});

test("withTenants sets the tenant list and the timeout in one statement on the app pool", async () => {
  await expect(withTenants([A, B], async () => "done")).resolves.toBe("done");
  expect(calls).toEqual([
    {
      pool: "app",
      config: undefined,
      queries: [
        {
          sql: "select set_config('app.tenant_ids', $1, true), set_config('statement_timeout', $2, true)",
          params: [`{${A},${B}}`, "5000"],
        },
      ],
    },
  ]);
});

test("withSystem sets the reason on the system pool and passes transaction options", async () => {
  await withSystem("jobs.lease", async () => undefined, {
    readOnly: true,
    isolation: "repeatable read",
    statementTimeoutMs: 250,
  });
  expect(calls).toEqual([
    {
      pool: "system",
      config: { isolationLevel: "repeatable read", accessMode: "read only" },
      queries: [
        {
          sql: "select set_config('app.system_reason', $1, true), set_config('statement_timeout', $2, true)",
          params: ["jobs.lease", "250"],
        },
      ],
    },
  ]);
});

test("translates driver errors and keeps the system reason for the event", async () => {
  const pg = Object.assign(new DatabaseError("permission denied", 0, "error"), { code: "42501" });
  failWith = pg;
  await expect(withSystem("auth", async () => 1)).rejects.toMatchObject({
    code: "internal",
    cause: pg,
  });
  await expect(withTenant(A, async () => 1)).rejects.toBeInstanceOf(AppError);
});

test("an AppError from the callback comes out as the same reference", async () => {
  const thrown = new AppError("not_found");
  await expect(
    withTenant(A, async () => {
      throw thrown;
    }),
  ).rejects.toBe(thrown);
});
