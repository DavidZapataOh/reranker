import { randomUUID } from "node:crypto";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { appPool, endPools } from "../src/client";
import { asTenantId, type TenantId, withSystem, withTenant, withTenants } from "../src/tenancy";
import { createProbeTable } from "./probe";

let probeTable: Awaited<ReturnType<typeof createProbeTable>>;
const probe = () => probeTable.table;
const tenants: TenantId[] = Array.from({ length: 40 }, () => asTenantId(randomUUID()));
const tenantAt = (i: number) => tenants[i % tenants.length] as TenantId;

beforeAll(async () => {
  probeTable = await createProbeTable();
  await withSystem("test.seed", (tx) =>
    tx.insert(probe()).values(tenants.map((tenantId, i) => ({ tenantId, label: `t${i}` }))),
  );
});

afterAll(async () => {
  try {
    await probeTable?.drop();
  } finally {
    await endPools();
  }
});

const ownRows = (tenant: TenantId) =>
  withTenant(tenant, (tx) => tx.select().from(probe())).then((rows) => rows.map((r) => r.tenantId));

// Pipelined transactions share pooled connections far more often than the pool has clients, so
// any setting, error or timeout that outlived its transaction would surface in another tenant.
// The workers keep the checkout queue short enough to stay inside the pool's connect timeout.
const WORKERS = 16;
const ROUNDS = 600;

test("concurrent lone, async, failing and timing-out transactions only ever see their own tenant", async () => {
  const failures: unknown[] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < ROUNDS; i = next++) {
      await round(i).catch((error: unknown) => failures.push(error));
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  expect(failures).toEqual([]);
  expect(appPool().totalCount).toBe(appPool().idleCount);
}, 120_000);

async function round(i: number): Promise<void> {
  const tenant = tenantAt(i);
  switch (i % 6) {
    case 0:
      expect(await ownRows(tenant)).toEqual([tenant]);
      return;
    case 1: {
      const { rows } = await withTenant(tenant, (tx) =>
        tx.execute<{ tenants: string }>(sql`select current_setting('app.tenant_ids') as tenants`),
      );
      expect(rows[0]?.tenants).toBe(`{${tenant}}`);
      return;
    }
    case 2: {
      const seen = await withTenant(tenant, async (tx) => {
        const { rows } = await tx.execute<{ tenants: string }>(
          sql`select current_setting('app.tenant_ids') as tenants`,
        );
        return [rows[0]?.tenants, (await tx.select().from(probe())).map((r) => r.tenantId)];
      });
      expect(seen).toEqual([`{${tenant}}`, [tenant]]);
      return;
    }
    case 3: {
      const error = await withTenant(tenant, (tx) =>
        tx.insert(probe()).values({ tenantId: tenantAt(i + 1) }),
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "internal" });
      return;
    }
    case 4: {
      const error = await withTenant(tenant, (tx) => tx.execute(sql`select pg_sleep(0.2)`), {
        statementTimeoutMs: 20,
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "timeout" });
      return;
    }
    default:
      expect(
        await withTenants([tenant, tenantAt(i + 1)], (tx) => tx.select().from(probe())),
      ).toHaveLength(2);
  }
}

test("withTenants with 1000 ids sees its own rows and nothing else", async () => {
  const ids = [
    ...tenants,
    ...Array.from({ length: 1000 - tenants.length }, () => asTenantId(randomUUID())),
  ];
  expect(await withTenants(ids, (tx) => tx.select().from(probe()))).toHaveLength(tenants.length);
});

test("a statement the callback queues on the microtask queue cannot slip in ahead of the lone query's COMMIT", async () => {
  const tenant = asTenantId(randomUUID());
  const label = `late-${randomUUID()}`;
  let late: unknown;
  const keep = (e: unknown) => {
    late = e;
  };
  const outcome = await withTenant(tenant, (tx) => {
    void Promise.resolve()
      .then(() => tx.insert(probe()).values({ tenantId: tenant, label }).then(undefined, keep))
      .catch(keep);
    return tx.select().from(probe());
  }).catch((e: unknown) => e);
  expect(outcome).toEqual([]);
  expect(late).toMatchObject({ code: "internal" });
  const written = await withSystem("test.verify", (tx) =>
    tx.select().from(probe()).where(eq(probe().label, label)),
  );
  expect(written).toEqual([]);
});

test("a backend killed mid-pipeline fails the run and the pool keeps serving", async () => {
  const tenant = tenantAt(0);
  const tag = `kill-${randomUUID()}`;
  const owner = new pg.Client({ connectionString: getTestDatabaseUrl("migrations") });
  await owner.connect();
  try {
    // The run can fail while the loop below still waits on the owner's socket, so its outcome is
    // taken at once; a handler attached only after the kill would leave that rejection unhandled.
    const run = withTenant(tenant, (tx) => tx.execute(sql`select pg_sleep(5), ${tag}::text`)).then(
      () => undefined,
      (error: unknown) => error,
    );
    const deadline = Date.now() + 4000;
    let killed = false;
    while (!killed && Date.now() < deadline) {
      const { rows } = await owner.query<{ killed: boolean }>(
        "select pg_terminate_backend(pid) as killed from pg_stat_activity where query like $1 and pid <> pg_backend_pid()",
        [`%pg_sleep(5)%`],
      );
      killed = rows.some((r) => r.killed);
      if (!killed) await new Promise((r) => setTimeout(r, 50));
    }
    expect(killed).toBe(true);
    // The run settles only after its client went back to the pool, so the cleanup is done here.
    expect(await run).toMatchObject({ code: "service_unavailable" });
    expect(appPool().totalCount).toBe(appPool().idleCount);
  } finally {
    await owner.end();
  }
  expect(await ownRows(tenant)).toEqual([tenant]);
});
