/// <reference types="vite/client" />
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AppError } from "@reranker/schema";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { uuid } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { endPools } from "../src/client";
import { appSchema, organizations } from "../src/schema";
import { type TenantId, withSystem, withTenant, withTenants } from "../src/tenancy";
import { defineTenantFixture, type TenantFixture } from "../src/testing";
import { runCatalogGate } from "./catalog-gate";
import { createTenant } from "./factories";
import { createScratchDatabase, type ScratchDatabase } from "./helpers";
import { onDatabase, probeStatements } from "./probe/database";
import * as probe from "./probe/isolation-probe.schema";

// One fixture per table in `app`; the catalog gate fails for a table without one.
const fixtures = Object.values(
  import.meta.glob<{ default: TenantFixture }>("./fixtures/*.ts", { eager: true }),
).map((module) => module.default);
const fixtureTables: ReadonlySet<string> = new Set(fixtures.map((fixture) => fixture.name));

const TENANT_EXPRESSION = "tenant_id = any ((select app.current_tenant_ids())::uuid[])";

// The suite owns a freshly migrated database: the probe tables, a committed house and the
// throwaway tables of the mutation cases never touch the database other test files share, and the
// gate sees exactly the migrated schema plus the probes.
let scratch: ScratchDatabase;
let owner: pg.Client;
let house: TenantId;
const saved = {
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_URL_SYSTEM: process.env.DATABASE_URL_SYSTEM,
  DB_POOL_MAX: process.env.DB_POOL_MAX,
};

beforeAll(async () => {
  const pooled = { app: getTestDatabaseUrl("app"), system: getTestDatabaseUrl("system") };
  scratch = await createScratchDatabase("isolation");
  await runMigrations({
    url: scratch.url,
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    concurrentFolder: fileURLToPath(new URL("../migrations/concurrent", import.meta.url)),
  });
  owner = new pg.Client({ connectionString: scratch.url });
  await owner.connect();
  for (const statement of await probeStatements()) await owner.query(statement);
  // The pools read these on first use; 20 lets the concurrency test queue without pool timeouts.
  process.env.DATABASE_URL = onDatabase(pooled.app, scratch.name);
  process.env.DATABASE_URL_SYSTEM = onDatabase(pooled.system, scratch.name);
  process.env.DB_POOL_MAX = "20";
  house = await withSystem("test.setup", (tx) => createTenant(tx, { kind: "house" }));
}, 180_000);

afterAll(async () => {
  try {
    await endPools();
    await owner?.end();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await scratch?.drop();
  }
});

function causeCode(error: unknown): unknown {
  return ((error as Error).cause as { code?: unknown } | undefined)?.code;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail("expected the database to reject the statement"),
    (error: unknown) => error,
  );
}

async function expectRlsRejection(promise: Promise<unknown>): Promise<void> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ code: "internal" });
  expect(causeCode(error)).toBe("42501");
}

async function pgCode(promise: Promise<unknown>): Promise<unknown> {
  return ((await rejection(promise)) as { code?: unknown }).code;
}

async function inRolledBackTx(client: pg.Client, fn: (c: pg.Client) => Promise<void>) {
  await client.query("begin");
  try {
    await fn(client);
  } finally {
    await client.query("rollback");
  }
}

async function withAppClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: getTestDatabaseUrl("app") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

async function insertRow(fixture: TenantFixture, tenant: TenantId): Promise<string> {
  return withSystem("test.setup", async (tx) => {
    const [row] = await tx
      .insert(fixture.table)
      .values(await fixture.build(tenant, tx))
      .returning({ id: fixture.id });
    if (!row) throw new Error(`${fixture.name}: insert returned no row`);
    return row.id as string;
  });
}

const buildFor = (fixture: TenantFixture, tenant: TenantId) =>
  withSystem("test.setup", (tx) => fixture.build(tenant, tx));

const visibleTo = (fixture: TenantFixture, tenants: TenantId[]) =>
  withTenants(tenants, (tx) =>
    tx.select({ id: fixture.id, tenantId: fixture.tenantId }).from(fixture.table),
  ) as Promise<{ id: string; tenantId: string }[]>;

const newTenants = (count: number) =>
  withSystem("test.setup", async (tx) => {
    const ids: TenantId[] = [];
    while (ids.length < count) ids.push(await createTenant(tx));
    return ids;
  });

// Mirrors what tenantTable emits, so each mutation case breaks exactly one rule.
function tenantTableSql(
  name: string,
  {
    tenantPolicy = `using (${TENANT_EXPRESSION}) with check (${TENANT_EXPRESSION})`,
    unique = "tenant_id, id",
    index = true,
    rls = true,
    tenantColumn = "tenant_id uuid not null references auth.organizations(id) on delete cascade",
  } = {},
): string {
  return `
    create table app.${name} (id uuid primary key default uuidv7(), ${tenantColumn}${unique ? `, constraint ${name}_tenant_id_id_key unique (${unique})` : ""});
    ${rls ? `alter table app.${name} enable row level security;` : ""}
    create policy ${name}_tenant_isolation on app.${name} as permissive for all to app_tenant ${tenantPolicy};
    create policy ${name}_system_access on app.${name} as permissive for all to app_system using (true) with check (true);
    ${index ? `create index ${name}_tenant_id_idx on app.${name} (tenant_id);` : ""}`;
}

describe("catalog gate", () => {
  test("catalog gate passes for every app table, including isolation_probe", async () => {
    expect(await runCatalogGate(owner, fixtureTables)).toEqual([]);
    const { rows } = await owner.query<{ table: string }>(
      "select relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind in ('r', 'p')",
    );
    const appTables = rows.map((row) => row.table);
    expect(appTables).toEqual(
      expect.arrayContaining(["isolation_probe", "isolation_probe_children"]),
    );
    expect([...fixtureTables].sort()).toEqual([...appTables].sort());
  });

  const runtimeRole = `gate_runtime_${randomBytes(4).toString("hex")}`;
  // [table, rule it breaks, DDL creating it]
  const gateCases: [string, string, string][] = (
    [
      [
        "create table app.gate_no_policy (id uuid primary key, tenant_id uuid not null)",
        "gate_no_policy",
        "tenant_policy",
      ],
      [
        `${tenantTableSql("gate_simple_fk")} alter table app.gate_simple_fk add column other_id uuid references app.isolation_probe(id);`,
        "gate_simple_fk",
        "composite_fk",
      ],
      [tenantTableSql("gate_no_fixture"), "gate_no_fixture", "fixture"],
      [
        tenantTableSql("gate_no_index", { unique: "id, tenant_id", index: false }),
        "gate_no_index",
        "tenant_index",
      ],
      [
        "create table public_panel.gate_tenant (id uuid primary key, tenant_id uuid)",
        "gate_tenant",
        "shared_no_tenant",
      ],
      [
        "create table ops.gate_grant (id uuid primary key); grant select on ops.gate_grant to app_tenant",
        "gate_grant",
        "ops_no_tenant_privilege",
      ],
      [
        "create table auth.gate_auth (id uuid primary key); grant select on auth.gate_auth to app_tenant",
        "gate_auth",
        "auth_no_tenant_privilege",
      ],
      [
        "create table public_panel.gate_write (id uuid primary key); grant insert on public_panel.gate_write to app_tenant",
        "gate_write",
        "shared_select_only",
      ],
      [
        `${tenantTableSql("gate_public")} grant select on app.gate_public to public;`,
        "gate_public",
        "no_public_grants",
      ],
      [
        tenantTableSql("gate_open", { tenantPolicy: "using (true) with check (true)" }),
        "gate_open",
        "tenant_policy",
      ],
      [
        tenantTableSql("gate_or_true", {
          tenantPolicy: `using (${TENANT_EXPRESSION} or true) with check (${TENANT_EXPRESSION})`,
        }),
        "gate_or_true",
        "tenant_policy",
      ],
      [
        tenantTableSql("gate_open_check", {
          tenantPolicy: `using (${TENANT_EXPRESSION}) with check (true)`,
        }),
        "gate_open_check",
        "tenant_policy",
      ],
      [
        `${tenantTableSql("gate_extra")} create policy gate_extra_public on app.gate_extra for select to public using (true);`,
        "gate_extra",
        "tenant_policy",
      ],
      [
        tenantTableSql("gate_system_to_tenant").replace(
          "for all to app_system",
          "for all to app_tenant",
        ),
        "gate_system_to_tenant",
        "tenant_policy",
      ],
      [tenantTableSql("gate_no_rls", { rls: false }), "gate_no_rls", "rls_enabled"],
      [
        tenantTableSql("gate_nullable", {
          tenantColumn: "tenant_id uuid references auth.organizations(id) on delete cascade",
        }),
        "gate_nullable",
        "tenant_id_not_null",
      ],
      [tenantTableSql("gate_no_unique", { unique: "" }), "gate_no_unique", "tenant_id_id_unique"],
      [
        tenantTableSql("gate_no_cascade", {
          tenantColumn: "tenant_id uuid not null references auth.organizations(id)",
        }),
        "gate_no_cascade",
        "tenant_fk_cascade",
      ],
      ["create table app.gate_no_system (id uuid primary key)", "gate_no_system", "system_policy"],
      [
        `${tenantTableSql("gate_owned")} create role ${runtimeRole} nologin in role app_tenant; grant ${runtimeRole} to current_user; grant create on schema app to ${runtimeRole}; alter table app.gate_owned owner to ${runtimeRole};`,
        "gate_owned",
        "runtime_not_owner",
      ],
    ] as [string, string, string][]
  ).map(([ddl, table, rule]) => [table, rule, ddl]);
  test.each(gateCases)("gate rejects %s for %s, naming the table", async (table, rule, ddl) => {
    await inRolledBackTx(owner, async (c) => {
      await c.query(ddl);
      expect(await runCatalogGate(c, fixtureTables)).toContainEqual(
        expect.objectContaining({ table, rule, message: expect.stringContaining(table) }),
      );
    });
  });
});

describe.each(fixtures)("tenant table $name", (fixture) => {
  let A: TenantId;
  let B: TenantId;
  const rows = { A: "", B: "", H: "" };

  beforeAll(async () => {
    [A, B] = (await newTenants(2)) as [TenantId, TenantId];
    rows.A = await insertRow(fixture, A);
    rows.B = await insertRow(fixture, B);
    rows.H = await insertRow(fixture, house);
  });

  test("withTenant(A) sees only A rows", async () => {
    const seen = await visibleTo(fixture, [A]);
    expect(seen.map((row) => row.id)).toContain(rows.A);
    expect(seen.filter((row) => row.tenantId !== A)).toEqual([]);
  });

  test("update and delete targeting B rows affect 0 rows", async () => {
    await withTenant(A, async (tx) => {
      const updated = await tx.execute(
        sql`update ${fixture.table} set ${sql.identifier("tenant_id")} = ${sql.identifier("tenant_id")} where ${fixture.id} = ${rows.B}`,
      );
      expect(updated.rowCount).toBe(0);
      const deleted = await tx
        .delete(fixture.table)
        .where(eq(fixture.id, rows.B))
        .returning({ id: fixture.id });
      expect(deleted).toEqual([]);
    });
    expect((await visibleTo(fixture, [B])).map((row) => row.id)).toContain(rows.B);
  });

  test("insert with tenant_id = B → AppError internal with cause.code 42501", async () => {
    const values = await buildFor(fixture, B);
    await expectRlsRejection(withTenant(A, (tx) => tx.insert(fixture.table).values(values)));
  });

  test("changing tenant_id from A to B → cause.code 42501", async () => {
    await expectRlsRejection(
      withTenant(A, (tx) =>
        tx.execute(
          sql`update ${fixture.table} set ${sql.identifier("tenant_id")} = ${B} where ${fixture.id} = ${rows.A}`,
        ),
      ),
    );
  });

  test("transaction without set_config sees 0 rows and cannot insert", async () => {
    const values = await buildFor(fixture, A);
    await withAppClient(async (client) => {
      const db = drizzle({ client, casing: "snake_case" });
      await client.query("begin");
      try {
        expect(await db.select({ id: fixture.id }).from(fixture.table)).toEqual([]);
        expect(causeCode(await rejection(db.insert(fixture.table).values(values)))).toBe("42501");
      } finally {
        await client.query("rollback");
      }
    });
  });

  test("withTenants([A, B]) sees both", async () => {
    const seen = await visibleTo(fixture, [A, B]);
    expect(seen.map((row) => row.id)).toEqual(expect.arrayContaining([rows.A, rows.B]));
    expect(seen.filter((row) => row.tenantId !== A && row.tenantId !== B)).toEqual([]);
  });

  test("tenant A does not see house rows", async () => {
    expect((await visibleTo(fixture, [A])).map((row) => row.id)).not.toContain(rows.H);
    expect((await visibleTo(fixture, [house])).map((row) => row.id)).toContain(rows.H);
  });

  test("deleting organization A cascades every A row", async () => {
    await withSystem("test.cleanup", (tx) =>
      tx.delete(organizations).where(eq(organizations.id, A)),
    );
    const left = await withSystem("test.check", (tx) =>
      tx
        .select({ id: fixture.id })
        .from(fixture.table)
        .where(inArray(fixture.tenantId, [A, B])),
    );
    expect(left.map((row) => row.id)).not.toContain(rows.A);
    expect(left.map((row) => row.id)).toContain(rows.B);
    expect(await visibleTo(fixture, [A])).toEqual([]);
  });
});

describe("runtime permissions", () => {
  test("reranker_app gets permission denied on select auth.users, select ops.<any>, insert public_panel.<any>", async () => {
    await withAppClient(async (client) => {
      expect(await pgCode(client.query("select 1 from auth.users limit 1"))).toBe("42501");
      expect(await pgCode(client.query("select 1 from ops.ops_probe limit 1"))).toBe("42501");
      expect(
        await pgCode(client.query("insert into public_panel.shared_probe (label) values ('x')")),
      ).toBe("42501");
      expect((await client.query("select 1 from public_panel.shared_probe")).rowCount).toBe(0);
    });
  });

  test("composite FK: inserting a child of A pointing to a probe row of B fails with 23503 even from withSystem", async () => {
    const [A, B] = (await newTenants(2)) as [TenantId, TenantId];
    const [parentOfB] = await withSystem("test.setup", (tx) =>
      tx
        .insert(probe.isolationProbe)
        .values({ tenantId: B, label: "parent of B" })
        .returning({ id: probe.isolationProbe.id }),
    );
    const error = await rejection(
      withSystem("test.setup", (tx) =>
        tx.insert(probe.isolationProbeChildren).values({
          tenantId: A,
          probeId: parentOfB?.id as string,
          secret: randomBytes(32),
        }),
      ),
    );
    expect(error).toBeInstanceOf(AppError);
    expect(causeCode(error)).toBe("23503");
  });
});

describe("pooler", () => {
  type Read = { tenant: TenantId; inherited: string | null; seen: string[] };

  // Mirrors withTenant by hand so the session state is read before anything is set.
  async function rawTx(pool: pg.Pool, tenant: TenantId): Promise<Read> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const inherited = (
        await client.query<{ value: string | null }>(
          "select current_setting('app.tenant_ids', true) as value",
        )
      ).rows[0]?.value as string | null;
      await client.query("select set_config('app.tenant_ids', $1, true)", [`{${tenant}}`]);
      const seen = (
        await client.query<{ tenant_id: string }>("select tenant_id from app.isolation_probe")
      ).rows.map((row) => row.tenant_id);
      await client.query("commit");
      return { tenant, inherited, seen };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  test("200 concurrent pooled transactions alternating A and B: 0 cross reads, 0 inherited variables", async () => {
    const [A, B] = (await newTenants(2)) as [TenantId, TenantId];
    await withSystem("test.setup", (tx) =>
      tx
        .insert(probe.isolationProbe)
        .values(
          [A, B].flatMap((tenantId) => range(3).map((i) => ({ tenantId, label: `row ${i}` }))),
        ),
    );
    const pick = (i: number) => (i % 2 ? A : B);
    const pool = new pg.Pool({ connectionString: getTestDatabaseUrl("app"), max: 50 });
    try {
      const results = await Promise.all(range(200).map((i) => rawTx(pool, pick(i))));
      expect(results.filter((r) => r.inherited !== "" && r.inherited !== null)).toHaveLength(0);
      expect(results.filter((r) => r.seen.length !== 3)).toHaveLength(0);
      expect(results.filter((r) => r.seen.some((t) => t !== r.tenant))).toHaveLength(0);
    } finally {
      await pool.end();
    }
    // As many workers as pooled connections: every connection is reused by both tenants, and
    // none of the 200 waits past the pool's 2 s checkout timeout in the queue.
    const viaTenancy: { tenant: TenantId; seen: string[] }[] = [];
    let next = 0;
    await Promise.all(
      range(Number(process.env.DB_POOL_MAX)).map(async () => {
        while (next < 200) {
          const tenant = pick(next++);
          const seen = await withTenant(tenant, (tx) =>
            tx.select({ tenantId: probe.isolationProbe.tenantId }).from(probe.isolationProbe),
          );
          viaTenancy.push({ tenant, seen: seen.map((row) => row.tenantId) });
        }
      }),
    );
    expect(viaTenancy).toHaveLength(200);
    expect(
      viaTenancy.filter((r) => r.seen.length !== 3 || r.seen.some((t) => t !== r.tenant)),
    ).toHaveLength(0);
  }, 60_000);
});

describe("house", () => {
  test("a house row is invisible to withTenant(A); copying it with withSystem('auth.claim_free_reports') leaves it in A and in the house", async () => {
    const table = probe.isolationProbe;
    const [A] = (await newTenants(1)) as [TenantId];
    const [original] = await withSystem("test.setup", (tx) =>
      tx.insert(table).values({ tenantId: house, label: "free report" }).returning(),
    );
    const id = original?.id as string;
    expect(await withTenant(A, (tx) => tx.select().from(table).where(eq(table.id, id)))).toEqual(
      [],
    );
    const copy = await withSystem("auth.claim_free_reports", async (tx) => {
      const [source] = await tx.select().from(table).where(eq(table.id, id));
      const [row] = await tx
        .insert(table)
        .values({ tenantId: A, label: source?.label as string })
        .returning();
      return row;
    });
    expect(await withTenant(A, (tx) => tx.select().from(table))).toEqual([
      expect.objectContaining({ id: copy?.id, tenantId: A, label: "free report" }),
    ]);
    expect(
      await withTenant(house, (tx) => tx.select().from(table).where(eq(table.id, id))),
    ).toEqual([expect.objectContaining({ tenantId: house, label: "free report" })]);
  });
});

// The behavior checks above must fail for a wrong policy; a table whose tenant policy is
// `using (true)` proves they would catch the leak in reads and in writes.
describe("mutation: a leaky tenant policy is caught by the behavior checks", () => {
  const leaky = appSchema.table("leaky_probe", {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    tenantId: uuid().notNull(),
  });
  const fixture = defineTenantFixture(leaky, (tenantId) => ({ tenantId }));

  beforeAll(async () => {
    await owner.query(
      tenantTableSql("leaky_probe", { tenantPolicy: "using (true) with check (true)" }),
    );
  });
  afterAll(async () => {
    await owner.query("drop table if exists app.leaky_probe");
  });

  test("cross-tenant reads and writes go through, and the gate names the table", async () => {
    const [A, B] = (await newTenants(2)) as [TenantId, TenantId];
    const rowOfB = await insertRow(fixture, B);
    const seen = await visibleTo(fixture, [A]);
    expect(seen.map((row) => row.id)).toContain(rowOfB);
    await expect(
      withTenant(A, (tx) => tx.insert(leaky).values({ tenantId: B })),
    ).resolves.toBeDefined();
    expect(await runCatalogGate(owner, new Set([...fixtureTables, "leaky_probe"]))).toEqual([
      expect.objectContaining({ table: "leaky_probe", rule: "tenant_policy" }),
    ]);
  });
});
