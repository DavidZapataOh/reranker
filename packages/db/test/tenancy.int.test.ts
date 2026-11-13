import { randomUUID } from "node:crypto";
import { AppError } from "@reranker/schema";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import { eq, inArray, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { endPools } from "../src/client";
import { asTenantId, type TenantTx, withSystem, withTenant, withTenants } from "../src/tenancy";
import { createProbeTable } from "./probe";

const A = asTenantId(randomUUID());
const B = asTenantId(randomUUID());
let probeTable: Awaited<ReturnType<typeof createProbeTable>>;
const probe = () => probeTable.table;

function causeCode(error: unknown): unknown {
  return ((error as Error).cause as { code?: unknown } | undefined)?.code;
}

beforeAll(async () => {
  probeTable = await createProbeTable();
  await withSystem("test.seed", (tx) =>
    tx.insert(probe()).values([
      { tenantId: A, label: "a1" },
      { tenantId: A, label: "a2" },
      { tenantId: B, label: "b1" },
    ]),
  );
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  try {
    await probeTable?.drop();
  } finally {
    await endPools();
  }
});

const labels = (rows: { label: string | null }[]) => rows.map((r) => r.label).sort();

test("withTenant(A) sees only A; withTenants([A,B]) sees both", async () => {
  expect(labels(await withTenant(A, (tx) => tx.select().from(probe())))).toEqual(["a1", "a2"]);
  expect(labels(await withTenant(B, (tx) => tx.select().from(probe())))).toEqual(["b1"]);
  expect(labels(await withTenants([A, B], (tx) => tx.select().from(probe())))).toEqual([
    "a1",
    "a2",
    "b1",
  ]);
});

test("update/delete on B rows affect 0 rows; insert with tenant_id = B rejects with 42501 as AppError internal", async () => {
  await withTenant(A, async (tx) => {
    const updated = await tx
      .update(probe())
      .set({ label: "stolen" })
      .where(eq(probe().tenantId, B))
      .returning();
    const deleted = await tx.delete(probe()).where(eq(probe().tenantId, B)).returning();
    expect([updated, deleted]).toEqual([[], []]);
  });
  const insert = withTenant(A, (tx) => tx.insert(probe()).values({ tenantId: B, label: "x" }));
  await expect(insert).rejects.toBeInstanceOf(AppError);
  const error = await insert.catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "internal" });
  expect(causeCode(error)).toBe("42501");
  expect(String((error as Error).message)).not.toContain("tenancy_probe");

  const move = await withTenant(A, (tx) =>
    tx.update(probe()).set({ tenantId: B }).where(eq(probe().label, "a1")),
  ).catch((e: unknown) => e);
  expect(causeCode(move)).toBe("42501");

  const all = await withSystem("test.verify", (tx) => tx.select().from(probe()));
  expect(labels(all)).toEqual(["a1", "a2", "b1"]);
  expect(all.find((r) => r.label === "a1")?.tenantId).toBe(A);
});

test("a transaction on reranker_app without set_config sees 0 rows and cannot insert", async () => {
  const client = new pg.Client({ connectionString: getTestDatabaseUrl("app") });
  await client.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(`select count(*)::int as n from app.${probeTable.name}`);
    expect(rows).toEqual([{ n: 0 }]);
    await expect(
      client.query(`insert into app.${probeTable.name} (tenant_id) values ($1)`, [A]),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("rollback");
  } finally {
    await client.end();
  }
});

test("unknown tenant id sees 0 rows", async () => {
  expect(await withTenant(asTenantId(randomUUID()), (tx) => tx.select().from(probe()))).toEqual([]);
});

test("statementTimeoutMs: 200 with pg_sleep(1) → AppError timeout", async () => {
  const started = performance.now();
  const error = await withTenant(A, (tx) => tx.execute(sql`select pg_sleep(1)`), {
    statementTimeoutMs: 200,
  }).catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "timeout" });
  expect(causeCode(error)).toBe("57014");
  expect(performance.now() - started).toBeLessThan(1000);
});

test("readOnly: insert → 25006 error, tx rolled back", async () => {
  const error = await withTenant(
    A,
    async (tx) => {
      expect(await tx.select().from(probe())).toHaveLength(2);
      await tx.insert(probe()).values({ tenantId: A, label: "read-only" });
    },
    { readOnly: true },
  ).catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "internal" });
  expect(causeCode(error)).toBe("25006");
  const rows = await withSystem("test.verify", (tx) =>
    tx.select().from(probe()).where(eq(probe().label, "read-only")),
  );
  expect(rows).toEqual([]);
});

test("isolation and access mode reach the transaction", async () => {
  const [row] = await withTenant(
    A,
    async (tx) =>
      (
        await tx.execute<{ isolation: string; read_only: string }>(
          sql`select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only`,
        )
      ).rows,
    { isolation: "serializable", readOnly: true },
  );
  expect(row).toEqual({ isolation: "serializable", read_only: "on" });
});

test("fn throwing an AppError rolls back and rethrows the same reference", async () => {
  const thrown = new AppError("not_found");
  const label = `rollback-${randomUUID()}`;
  const error = await withTenant(A, async (tx) => {
    await tx.insert(probe()).values({ tenantId: A, label });
    throw thrown;
  }).catch((e: unknown) => e);
  expect(error).toBe(thrown);
  const rows = await withSystem("test.verify", (tx) =>
    tx.select().from(probe()).where(eq(probe().label, label)),
  );
  expect(rows).toEqual([]);
});

test("23505 inside withSystem → AppError conflict", async () => {
  const id = randomUUID();
  const error = await withSystem("test.conflict", (tx) =>
    tx.insert(probe()).values([
      { id, tenantId: A },
      { id, tenantId: B },
    ]),
  ).catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "conflict" });
  expect(causeCode(error)).toBe("23505");
});

test("one round trip to fix the tenant: queries are [begin, set_config, select, commit]", async () => {
  const [row] = await withSystem("test.seed", (tx) =>
    tx.insert(probe()).values({ tenantId: A, label: "trace" }).returning(),
  );
  const seen: string[] = [];
  const original = pg.Client.prototype.query;
  vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    const [query] = args;
    seen.push(typeof query === "string" ? query : (query as { text: string }).text);
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof original);
  const found = await withTenant(A, (tx) =>
    tx
      .select()
      .from(probe())
      .where(eq(probe().id, row?.id as string)),
  );
  vi.restoreAllMocks();
  expect(found).toHaveLength(1);
  const kind = (text: string) =>
    text.startsWith("select set_config") ? "select set_config" : text.split(/\s/)[0];
  expect(seen.map(kind)).toEqual(["begin", "select set_config", "select", "commit"]);
  await withSystem("test.cleanup", (tx) =>
    tx.delete(probe()).where(inArray(probe().label, ["trace"])),
  );
});

test("withSystem tx carries app.system_reason and statement_timeout locally", async () => {
  const read = (statementTimeoutMs?: number) =>
    withSystem(
      "auth.claim_free_reports",
      async (tx) =>
        (
          await tx.execute<{ reason: string; timeout: string; tenants: string }>(
            sql`select current_setting('app.system_reason') as reason, current_setting('statement_timeout') as timeout, coalesce(current_setting('app.tenant_ids', true), '') as tenants`,
          )
        ).rows[0],
      statementTimeoutMs === undefined ? {} : { statementTimeoutMs },
    );
  expect(await read()).toEqual({ reason: "auth.claim_free_reports", timeout: "5s", tenants: "" });
  expect(await read(1234)).toMatchObject({ timeout: "1234ms" });
  const tenant = await withTenant(
    A,
    async (tx) =>
      (
        await tx.execute<{ reason: string; timeout: string }>(
          sql`select coalesce(current_setting('app.system_reason', true), '') as reason, current_setting('statement_timeout') as timeout`,
        )
      ).rows[0],
  );
  expect(tenant).toEqual({ reason: "", timeout: "5s" });
});

test("a handle kept past the callback cannot reach the connection that went back to the pool", async () => {
  let stored: TenantTx | undefined;
  let pending: PromiseLike<unknown> | undefined;
  await withTenant(A, async (tx) => {
    stored = tx;
    pending = tx.select().from(probe());
  });
  expect(() => stored?.select().from(probe())).toThrow(
    expect.objectContaining({ code: "internal" }),
  );
  const late = await Promise.resolve(pending).catch((e: unknown) => e);
  expect((late as Error).cause ?? late).toMatchObject({ code: "internal" });
});
