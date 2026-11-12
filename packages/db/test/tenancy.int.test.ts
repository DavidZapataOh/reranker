import { randomUUID } from "node:crypto";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import { eq, sql } from "drizzle-orm";
import { text, uuid } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { AppError } from "../src/app-error.ts";
import { closeDb } from "../src/client.ts";
import { pgCodeOf } from "../src/errors.ts";
import { appSchema } from "../src/schema/index.ts";
import { asTenantId, withSystem, withTenant, withTenants } from "../src/tenancy.ts";
import { ownerUrl, withClient } from "./support.ts";

// A tenant table without foreign keys, created on the CI branch only for this suite.
const probe = appSchema.table("tenancy_probe", {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  tenantId: uuid().notNull(),
  label: text().notNull(),
});

const A = asTenantId(randomUUID());
const B = asTenantId(randomUUID());
const UNKNOWN = asTenantId(randomUUID());

const DDL = `
  drop table if exists app.tenancy_probe;
  create table app.tenancy_probe (
    id uuid primary key default uuidv7(),
    tenant_id uuid not null,
    label text not null unique
  );
  alter table app.tenancy_probe enable row level security;
  create policy tenancy_probe_tenant_isolation on app.tenancy_probe as permissive for all to app_tenant
    using (tenant_id = any ((select app.current_tenant_ids())))
    with check (tenant_id = any ((select app.current_tenant_ids())));
  create policy tenancy_probe_system_access on app.tenancy_probe as permissive for all to app_system
    using (true) with check (true);
`;

let rowOfB: string;

beforeAll(async () => {
  await withClient(ownerUrl(), (c) => c.query(DDL));
  await withSystem("test.setup", async (tx) => {
    await tx.insert(probe).values([
      { tenantId: A, label: "a-1" },
      { tenantId: A, label: "a-2" },
    ]);
    const [b] = await tx.insert(probe).values({ tenantId: B, label: "b-1" }).returning();
    rowOfB = b?.id ?? "";
  });
});

afterAll(async () => {
  await closeDb();
  await withClient(ownerUrl(), (c) => c.query("drop table if exists app.tenancy_probe"));
});

const labels = (rows: { label: string }[]) => rows.map((r) => r.label).sort();

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("withTenant", () => {
  test("sees only its own rows; withTenants sees every listed tenant", async () => {
    expect(labels(await withTenant(A, (tx) => tx.select().from(probe)))).toEqual(["a-1", "a-2"]);
    expect(labels(await withTenant(B, (tx) => tx.select().from(probe)))).toEqual(["b-1"]);
    expect(labels(await withTenants([A, B], (tx) => tx.select().from(probe)))).toEqual([
      "a-1",
      "a-2",
      "b-1",
    ]);
  });

  test("an unknown tenant sees no rows", async () => {
    expect(await withTenant(UNKNOWN, (tx) => tx.select().from(probe))).toEqual([]);
  });

  test("update and delete targeting another tenant's rows affect 0 rows", async () => {
    const updated = await withTenant(A, (tx) =>
      tx.update(probe).set({ label: "hijacked" }).where(eq(probe.id, rowOfB)).returning(),
    );
    const deleted = await withTenant(A, (tx) =>
      tx.delete(probe).where(eq(probe.id, rowOfB)).returning(),
    );
    expect([updated, deleted]).toEqual([[], []]);
    expect(labels(await withTenant(B, (tx) => tx.select().from(probe)))).toEqual(["b-1"]);
  });

  test("inserting a row for another tenant is rejected with 42501 as AppError internal", async () => {
    const error = await rejection(
      withTenant(A, (tx) => tx.insert(probe).values({ tenantId: B, label: "smuggled" })),
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "internal" });
    expect(pgCodeOf((error as AppError).cause)).toBe("42501");
  });

  test("moving a row to another tenant is rejected with 42501", async () => {
    const error = await rejection(
      withTenant(A, (tx) => tx.update(probe).set({ tenantId: B }).where(eq(probe.label, "a-1"))),
    );
    expect(pgCodeOf((error as AppError).cause)).toBe("42501");
  });

  test("a raw reranker_app transaction without set_config sees no rows and cannot insert", async () => {
    await withClient(getTestDatabaseUrl("app"), async (c) => {
      await c.query("begin");
      const { rows } = await c.query("select count(*)::int as count from app.tenancy_probe");
      expect(rows).toEqual([{ count: 0 }]);
      await expect(
        c.query("insert into app.tenancy_probe (tenant_id, label) values ($1, 'raw')", [A]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("rollback");
    });
  });

  test("statementTimeoutMs cancels a slow statement as AppError timeout", async () => {
    await expect(
      withTenant(A, (tx) => tx.execute(sql`select pg_sleep(1)`), { statementTimeoutMs: 200 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  test("readOnly rejects writes and leaves nothing behind", async () => {
    const error = await rejection(
      withTenant(A, (tx) => tx.insert(probe).values({ tenantId: A, label: "ro" }), {
        readOnly: true,
      }),
    );
    expect(error).toMatchObject({ code: "internal" });
    expect(pgCodeOf((error as AppError).cause)).toBe("25006");
  });

  test("an AppError thrown by fn rolls back and is rethrown as the same reference", async () => {
    const thrown = new AppError("conflict", { detail: "domain rule" });
    const error = await rejection(
      withTenant(A, async (tx) => {
        await tx.insert(probe).values({ tenantId: A, label: "rolled-back" });
        throw thrown;
      }),
    );
    expect(error).toBe(thrown);
    const rows = await withTenant(A, (tx) =>
      tx.select().from(probe).where(eq(probe.label, "rolled-back")),
    );
    expect(rows).toEqual([]);
  });

  test("fixing the tenant costs one round trip: begin, set_config, query, commit", async () => {
    const query = vi.spyOn(pg.Client.prototype, "query");
    try {
      await withTenant(A, (tx) => tx.select().from(probe).where(eq(probe.label, "a-1")));
      const statements = query.mock.calls.map(([q]) =>
        (typeof q === "string" ? q : (q as { text: string }).text).trim().toLowerCase(),
      );
      expect(statements).toHaveLength(4);
      expect(statements[0]).toBe("begin");
      expect(statements[1]).toMatch(
        /^select set_config\('app\.tenant_ids', \$1, true\), set_config\('statement_timeout', \$2, true\)$/,
      );
      expect(statements[2]).toMatch(/^select .* from "app"\."tenancy_probe"/);
      expect(statements[3]).toBe("commit");
    } finally {
      query.mockRestore();
    }
  });
});

describe("withSystem", () => {
  test("sees every tenant and records the reason and timeout for the transaction only", async () => {
    const settings = await withSystem(
      "test.audit",
      async (tx) => {
        const rows = await tx.select().from(probe);
        const { rows: current } = await tx.execute<{ reason: string; timeout: string }>(
          sql`select current_setting('app.system_reason') as reason, current_setting('statement_timeout') as timeout`,
        );
        return { count: rows.length, ...current[0] };
      },
      { statementTimeoutMs: 1234 },
    );
    expect(settings).toMatchObject({ reason: "test.audit", timeout: "1234ms" });
    expect(settings.count).toBeGreaterThanOrEqual(3);
  });

  test("a unique violation becomes AppError conflict", async () => {
    await expect(
      withSystem("test.conflict", (tx) => tx.insert(probe).values({ tenantId: A, label: "a-1" })),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
