import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { getPool } from "../src/client.ts";
import { asTenantId, closeDbPools, withTenant } from "../src/index.ts";
import { defineProbe } from "./probe.ts";

// Pools are created lazily, so this takes effect for the whole file.
process.env.DB_POOL_MAX = "1";

const probe = defineProbe("pool_probe");
const A = asTenantId(randomUUID());
const B = asTenantId(randomUUID());

beforeAll(() => probe.create());
afterAll(async () => {
  await closeDbPools();
  await probe.drop();
});

test("with max 1 and one transaction held, the next fails in ≤ 2.5 s with service_unavailable", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = withTenant(A, async () => {
    entered();
    await gate;
  });
  await inside;
  const started = performance.now();
  await expect(withTenant(B, async () => 1)).rejects.toMatchObject({
    code: "service_unavailable",
    retryAfterSeconds: 2,
  });
  expect(performance.now() - started).toBeLessThanOrEqual(2500);
  release();
  await hold;
});

test("a nested withTenant fails with service_unavailable instead of hanging", async () => {
  const started = performance.now();
  await expect(withTenant(A, () => withTenant(B, async () => 1))).rejects.toMatchObject({
    code: "service_unavailable",
  });
  expect(performance.now() - started).toBeLessThanOrEqual(2500 + 1000);
});

test("after an RLS violation and a statement timeout the pooled client starts clean", async () => {
  await expect(
    withTenant(A, (tx) => tx.insert(probe.table).values({ id: randomUUID(), tenantId: B })),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
  await expect(
    withTenant(A, (tx) => tx.execute(sql`select pg_sleep(1)`), { statementTimeoutMs: 100 }),
  ).rejects.toMatchObject({ code: "timeout" });

  const pool = getPool("app");
  expect(pool.totalCount).toBe(1);
  const client = await pool.connect();
  try {
    const result = await client.query<{ tenants: string | null; timeout: string }>(
      `select nullif(current_setting('app.tenant_ids', true), '') as tenants,
              current_setting('statement_timeout') as timeout`,
    );
    expect(result.rows[0]).toEqual({ tenants: null, timeout: "15s" });
  } finally {
    client.release();
  }
});
