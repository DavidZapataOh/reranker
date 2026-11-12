import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeDb, getDb } from "../src/client.ts";
import { asTenantId, withTenant } from "../src/tenancy.ts";
import { ownerUrl, withClient } from "./support.ts";

// Pools are created lazily on first use, so this applies to the pools of this file only.
process.env.DB_POOL_MAX = "1";

const A = asTenantId(randomUUID());
const B = asTenantId(randomUUID());

beforeAll(async () => {
  await withClient(ownerUrl(), (c) =>
    c.query(`
      drop table if exists app.pool_probe;
      create table app.pool_probe (id uuid primary key default uuidv7(), tenant_id uuid not null);
      alter table app.pool_probe enable row level security;
      create policy pool_probe_tenant_isolation on app.pool_probe as permissive for all to app_tenant
        using (tenant_id = any ((select app.current_tenant_ids())))
        with check (tenant_id = any ((select app.current_tenant_ids())));
    `),
  );
});

afterAll(async () => {
  await closeDb();
  await withClient(ownerUrl(), (c) => c.query("drop table if exists app.pool_probe"));
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("with a pool of one connection", () => {
  test("a second transaction fails within 2.5 s as service_unavailable instead of hanging", async () => {
    const started = deferred();
    const release = deferred();
    const hold = withTenant(A, async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;

    const t0 = performance.now();
    await expect(withTenant(B, async () => 1)).rejects.toMatchObject({
      code: "service_unavailable",
      retryAfterSeconds: 2,
    });
    expect(performance.now() - t0).toBeLessThanOrEqual(2500);

    release.resolve();
    await hold;
  });

  test("a withTenant nested inside another fails as service_unavailable instead of deadlocking", async () => {
    const t0 = performance.now();
    await expect(withTenant(A, () => withTenant(B, async () => 1))).rejects.toMatchObject({
      code: "service_unavailable",
    });
    expect(performance.now() - t0).toBeLessThanOrEqual(2500);
  });

  test("after a 42501 and a 57014 the reused connection starts clean", async () => {
    await expect(
      withTenant(A, (tx) => tx.execute(sql`insert into app.pool_probe (tenant_id) values (${B})`)),
    ).rejects.toMatchObject({ code: "internal" });
    await expect(
      withTenant(A, (tx) => tx.execute(sql`select pg_sleep(1)`), { statementTimeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "timeout" });

    const { rows } = await getDb("app").execute<{ tenants: string | null; timeout: string }>(
      sql`select current_setting('app.tenant_ids', true) as tenants, current_setting('statement_timeout') as timeout`,
    );
    expect([null, ""]).toContain(rows[0]?.tenants);
    expect(rows[0]?.timeout).toBe("15s");
  });
});
