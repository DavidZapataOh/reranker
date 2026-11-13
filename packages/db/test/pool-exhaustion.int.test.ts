import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { appPool, endPools } from "../src/client";
import { type DbEvent, resetDbEventsForTest, setDbEventSink } from "../src/events";
import { asTenantId, withTenant } from "../src/tenancy";
import { createProbeTable } from "./probe";

// The pools read the variable when they are first created.
vi.hoisted(() => {
  process.env.DB_POOL_MAX = "1";
});

const A = asTenantId(randomUUID());
const B = asTenantId(randomUUID());
let probeTable: Awaited<ReturnType<typeof createProbeTable>>;

beforeAll(async () => {
  probeTable = await createProbeTable();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDbEventsForTest();
});

// Fails the first statement that starts with `prefix` and lets every other one reach Neon.
function failOnce(prefix: string, error: Error) {
  const original = pg.Client.prototype.query;
  let pending = true;
  vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    const [query] = args;
    const text = typeof query === "string" ? query : (query as { text: string }).text;
    if (pending && text.startsWith(prefix)) {
      pending = false;
      return Promise.reject(error);
    }
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof original);
}

const session = async () =>
  (
    await appPool().query<{ tenants: string; timeout: string }>(
      "select coalesce(current_setting('app.tenant_ids', true), '') as tenants, current_setting('statement_timeout') as timeout",
    )
  ).rows[0];

test("a failed BEGIN gives the only slot back: the next transaction runs at once", async () => {
  expect(await withTenant(A, async () => 0)).toBe(0);
  const dropped = Object.assign(new pg.DatabaseError("terminating connection", 0, "error"), {
    code: "57P01",
  });
  failOnce("begin", dropped);
  await expect(withTenant(A, async () => 1)).rejects.toMatchObject({
    code: "service_unavailable",
  });
  vi.restoreAllMocks();
  expect(appPool().totalCount).toBe(appPool().idleCount);
  const started = performance.now();
  expect(await withTenant(A, async () => 2)).toBe(2);
  expect(performance.now() - started).toBeLessThan(1500);
});

test("a failed ROLLBACK keeps the original 42501 and its event, and the slot comes back clean", async () => {
  const events: DbEvent[] = [];
  setDbEventSink((event) => events.push(event));
  failOnce("rollback", new Error("Connection terminated unexpectedly"));
  const error = await withTenant(A, (tx) =>
    tx.insert(probeTable.table).values({ tenantId: B }),
  ).catch((e: unknown) => e);
  vi.restoreAllMocks();
  expect(error).toMatchObject({ code: "internal", cause: { code: "42501" } });
  expect(events).toEqual([{ name: "db_rls_violation", pool: "app", pgCode: "42501" }]);
  expect(appPool().totalCount).toBe(appPool().idleCount);
  expect(await session()).toEqual({ tenants: "", timeout: "15s" });
  expect(await withTenant(A, async () => 3)).toBe(3);
});

afterAll(async () => {
  try {
    await probeTable?.drop();
  } finally {
    await endPools();
  }
});

test("with max 1 and one transaction held, the second fails in ≤ 2.5 s with service_unavailable", async () => {
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
  expect(await withTenant(B, async () => 1)).toBe(1);
});

test("nested withTenant inside withTenant fails with service_unavailable instead of hanging", async () => {
  const started = performance.now();
  await expect(withTenant(A, () => withTenant(B, async () => 1))).rejects.toMatchObject({
    code: "service_unavailable",
  });
  expect(performance.now() - started).toBeLessThanOrEqual(2500);
  expect(await withTenant(A, async () => 2)).toBe(2);
});

test("after a 42501 and a 57014 the same connection starts clean (empty app.tenant_ids, default statement_timeout)", async () => {
  const clients = new Set<unknown>();
  const original = pg.Client.prototype.query;
  vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    clients.add(this);
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof original);
  const probe = probeTable.table;

  await expect(
    withTenant(A, (tx) => tx.insert(probe).values({ tenantId: B })),
  ).rejects.toMatchObject({ code: "internal", cause: { code: "42501" } });
  expect(await session()).toEqual({ tenants: "", timeout: "15s" });

  await expect(
    withTenant(A, (tx) => tx.execute(sql`select pg_sleep(1)`), { statementTimeoutMs: 200 }),
  ).rejects.toMatchObject({ code: "timeout", cause: { code: "57014" } });
  expect(await session()).toEqual({ tenants: "", timeout: "15s" });

  // A committed transaction must not leave its settings behind either.
  expect(await withTenant(A, async () => "ok", { statementTimeoutMs: 300 })).toBe("ok");
  expect(await session()).toEqual({ tenants: "", timeout: "15s" });

  vi.restoreAllMocks();
  expect(clients.size).toBe(1);
  expect(appPool().totalCount).toBe(1);
});
