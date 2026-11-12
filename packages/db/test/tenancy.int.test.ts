import { randomUUID } from "node:crypto";
import { AppError } from "@reranker/schema";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { asTenantId, closeDbPools, withSystem, withTenant, withTenants } from "../src/index.ts";
import { defineProbe } from "./probe.ts";
import { rejectionCode, withClient } from "./support.ts";

const probe = defineProbe("tenancy_probe");
const A = asTenantId(randomUUID());
const B = asTenantId(randomUUID());
const rowA = randomUUID();
const rowB = randomUUID();

beforeAll(async () => {
  await probe.create();
  await withSystem("test.setup", (tx) =>
    tx.insert(probe.table).values([
      { id: rowA, tenantId: A, label: "a" },
      { id: rowB, tenantId: B, label: "b" },
    ]),
  );
});

afterAll(async () => {
  await closeDbPools();
  await probe.drop();
});

const tenantsSeen = (rows: Array<{ tenantId: string }>) =>
  [...new Set(rows.map((r) => r.tenantId))].sort();

test("withTenant(A) sees only A; withTenants([A, B]) sees both", async () => {
  expect(tenantsSeen(await withTenant(A, (tx) => tx.select().from(probe.table)))).toEqual([A]);
  expect(tenantsSeen(await withTenants([A, B], (tx) => tx.select().from(probe.table)))).toEqual(
    [A, B].sort(),
  );
});

test("an unknown tenant sees no rows", async () => {
  expect(await withTenant(asTenantId(randomUUID()), (tx) => tx.select().from(probe.table))).toEqual(
    [],
  );
});

test("update and delete targeting B rows from A affect 0 rows", async () => {
  await withTenant(A, async (tx) => {
    const updated = await tx
      .update(probe.table)
      .set({ label: "x" })
      .where(eq(probe.table.id, rowB));
    const deleted = await tx.delete(probe.table).where(eq(probe.table.id, rowB));
    expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
  });
  const [b] = await withTenant(B, (tx) => tx.select().from(probe.table));
  expect(b?.label).toBe("b");
});

test("inserting or moving a row into B from A is rejected by RLS as an internal error", async () => {
  const insert = withTenant(A, (tx) =>
    tx.insert(probe.table).values({ id: randomUUID(), tenantId: B, label: "x" }),
  );
  await expect(insert).rejects.toBeInstanceOf(AppError);
  await expect(insert).rejects.toMatchObject({ code: "internal", cause: { code: "42501" } });

  const move = withTenant(A, (tx) =>
    tx.update(probe.table).set({ tenantId: B }).where(eq(probe.table.id, rowA)),
  );
  await expect(move).rejects.toMatchObject({ code: "internal", cause: { code: "42501" } });
});

test("a reranker_app transaction without set_config sees 0 rows and cannot insert", async () => {
  await withClient("app", async (client) => {
    await client.query("begin");
    const rows = await client.query(`select * from app."${probe.name}"`);
    expect(rows.rowCount).toBe(0);
    expect(
      await rejectionCode(
        client.query(`insert into app."${probe.name}" (tenant_id) values ($1)`, [A]),
      ),
    ).toBe("42501");
    await client.query("rollback");
  });
});

test("statementTimeoutMs bounds every statement and surfaces as a timeout", async () => {
  await expect(
    withTenant(A, (tx) => tx.execute(sql`select pg_sleep(1)`), { statementTimeoutMs: 200 }),
  ).rejects.toMatchObject({ code: "timeout" });
});

test("readOnly transactions reject writes and roll back", async () => {
  await expect(
    withTenant(A, (tx) => tx.insert(probe.table).values({ id: randomUUID(), tenantId: A }), {
      readOnly: true,
    }),
  ).rejects.toMatchObject({ code: "internal", cause: { code: "25006" } });
});

test("an AppError thrown by fn rolls back the work and is rethrown as the same reference", async () => {
  const id = randomUUID();
  const error = new AppError("forbidden");
  await expect(
    withTenant(A, async (tx) => {
      await tx.insert(probe.table).values({ id, tenantId: A });
      throw error;
    }),
  ).rejects.toBe(error);
  expect(
    await withTenant(A, (tx) => tx.select().from(probe.table).where(eq(probe.table.id, id))),
  ).toEqual([]);
});

test("a unique violation inside withSystem is a conflict", async () => {
  await expect(
    withSystem("test.conflict", (tx) => tx.insert(probe.table).values({ id: rowA, tenantId: A })),
  ).rejects.toMatchObject({ code: "conflict" });
});

test("withSystem sees every tenant and records its reason and timeout in the transaction", async () => {
  const result = await withSystem("test.reason", async (tx) => {
    const rows = await tx.select().from(probe.table);
    const settings = await tx.execute<{ reason: string; timeout: string; tenants: string | null }>(
      sql`select current_setting('app.system_reason') as reason,
                 current_setting('statement_timeout') as timeout,
                 nullif(current_setting('app.tenant_ids', true), '') as tenants`,
    );
    return { tenants: tenantsSeen(rows), settings: settings.rows[0] };
  });
  expect(result).toEqual({
    tenants: [A, B].sort(),
    settings: { reason: "test.reason", timeout: "5s", tenants: null },
  });
});

test("fixing the tenant costs one statement: begin, set_config, query, commit", async () => {
  const seen: string[] = [];
  const original = pg.Client.prototype.query;
  const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
    this: pg.Client,
    ...args: Parameters<pg.Client["query"]>
  ) {
    const [config] = args as unknown as [string | { text: string }];
    seen.push(typeof config === "string" ? config : config.text);
    return (original as (...a: unknown[]) => unknown).apply(this, args) as never;
  });
  try {
    await withTenant(A, (tx) => tx.select().from(probe.table).where(eq(probe.table.id, rowA)));
  } finally {
    spy.mockRestore();
  }
  expect(seen.map((text) => text.split(/\s+/).slice(0, 2).join(" "))).toEqual([
    "begin",
    "select set_config('app.tenant_ids',",
    'select "id",',
    "commit",
  ]);
});
