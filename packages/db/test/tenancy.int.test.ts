import { randomUUID } from "node:crypto";
import { AppError } from "@reranker/schema";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { closeDatabases } from "../src/client.ts";
import { asTenantId, withSystem, withTenant, withTenants } from "../src/index.ts";
import { createProbe, dropProbe, probeTable } from "./support/probe.ts";
import { connect, ownerUrl } from "./support/scratch-database.ts";

const PROBE = "tenancy_probe";
const probe = probeTable(PROBE);
const A = asTenantId(randomUUID());
const B = asTenantId(randomUUID());

let owner: pg.Client;

beforeAll(async () => {
  owner = await connect(ownerUrl());
  await createProbe(owner, PROBE);
});

afterAll(async () => {
  await closeDatabases();
  await dropProbe(owner, PROBE);
  await owner.end();
});

beforeEach(async () => {
  await owner.query(`truncate app.${PROBE}`);
  await withSystem("test.seed", (tx) =>
    tx.insert(probe).values([
      { tenantId: A, label: "a1" },
      { tenantId: A, label: "a2" },
      { tenantId: B, label: "b1" },
    ]),
  );
});

const labels = (rows: { label: string | null }[]) => rows.map((row) => row.label).sort();

describe("withTenant", () => {
  test("sees only its tenant, and withTenants sees each listed tenant", async () => {
    expect(labels(await withTenant(A, (tx) => tx.select().from(probe)))).toEqual(["a1", "a2"]);
    expect(labels(await withTenant(B, (tx) => tx.select().from(probe)))).toEqual(["b1"]);
    expect(labels(await withTenants([A, B], (tx) => tx.select().from(probe)))).toEqual([
      "a1",
      "a2",
      "b1",
    ]);
  });

  test("an unknown tenant sees no rows", async () => {
    expect(await withTenant(asTenantId(randomUUID()), (tx) => tx.select().from(probe))).toEqual([]);
  });

  test("update and delete on another tenant's rows affect nothing", async () => {
    const updated = await withTenant(A, (tx) =>
      tx.update(probe).set({ label: "stolen" }).where(eq(probe.tenantId, B)).returning(),
    );
    const deleted = await withTenant(A, (tx) =>
      tx.delete(probe).where(eq(probe.tenantId, B)).returning(),
    );
    expect([updated, deleted]).toEqual([[], []]);
    expect(labels(await withTenant(B, (tx) => tx.select().from(probe)))).toEqual(["b1"]);
  });

  test("writing a row into another tenant is rejected as internal and rolled back", async () => {
    await expect(
      withTenant(A, (tx) => tx.insert(probe).values({ tenantId: B, label: "planted" })),
    ).rejects.toMatchObject({
      code: "internal",
      cause: expect.objectContaining({ code: "42501" }),
    });
    await expect(
      withTenant(A, (tx) => tx.update(probe).set({ tenantId: B }).where(eq(probe.label, "a1"))),
    ).rejects.toMatchObject({
      code: "internal",
      cause: expect.objectContaining({ code: "42501" }),
    });
    expect(labels(await withTenant(B, (tx) => tx.select().from(probe)))).toEqual(["b1"]);
  });

  test("runs as reranker_app with the tenant list and a 5 s statement timeout", async () => {
    const [row] = await withTenants([A, B], async (tx) => {
      const result = await tx.execute<{ login: string; ids: string; timeout: string }>(
        sql`select current_user as login, current_setting('app.tenant_ids') as ids,
                   current_setting('statement_timeout') as timeout`,
      );
      return result.rows;
    });
    expect(row).toEqual({ login: "reranker_app", ids: `{${A},${B}}`, timeout: "5s" });
  });

  test("statementTimeoutMs cancels a slow statement as a timeout error", async () => {
    await expect(
      withTenant(A, (tx) => tx.execute(sql`select pg_sleep(1)`), { statementTimeoutMs: 200 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  test("readOnly refuses writes and keeps nothing", async () => {
    await expect(
      withTenant(A, (tx) => tx.insert(probe).values({ tenantId: A, label: "ro" }), {
        readOnly: true,
      }),
    ).rejects.toMatchObject({
      code: "internal",
      cause: expect.objectContaining({ code: "25006" }),
    });
    expect(labels(await withTenant(A, (tx) => tx.select().from(probe)))).toEqual(["a1", "a2"]);
  });

  test("an AppError thrown by the callback rolls back and comes out as the same reference", async () => {
    const thrown = new AppError("not_found");
    await expect(
      withTenant(A, async (tx) => {
        await tx.insert(probe).values({ tenantId: A, label: "temp" });
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    expect(labels(await withTenant(A, (tx) => tx.select().from(probe)))).toEqual(["a1", "a2"]);
  });

  test("serializable isolation is applied", async () => {
    const level = await withTenant(
      A,
      async (tx) =>
        (
          await tx.execute<{ level: string }>(
            sql`select current_setting('transaction_isolation') as level`,
          )
        ).rows[0]?.level,
      { isolation: "serializable" },
    );
    expect(level).toBe("serializable");
  });

  test("fixing the tenant costs one round trip: begin, set_config, the query, commit", async () => {
    const [row] = await withSystem("test.seed", (tx) => tx.select().from(probe).limit(1));
    const spy = vi.spyOn(pg.Client.prototype, "query");
    try {
      await withTenant(A, (tx) =>
        tx
          .select()
          .from(probe)
          .where(eq(probe.id, row?.id ?? "")),
      );
      const texts = spy.mock.calls.map(([query]) =>
        (typeof query === "string" ? query : (query as { text: string }).text).trim(),
      );
      expect(texts).toHaveLength(4);
      expect(texts[0]).toBe("begin");
      expect(texts[1]).toMatch(/^select set_config\('app\.tenant_ids'/);
      expect(texts[2]).toMatch(/^select .* from "app"\."tenancy_probe"/);
      expect(texts[3]).toBe("commit");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a raw transaction on reranker_app without the tenant variable", () => {
  test("sees no rows and cannot insert", async () => {
    const client = await connect(getTestDatabaseUrl("app"));
    try {
      await client.query("begin");
      const { rows } = await client.query(`select count(*)::int as n from app.${PROBE}`);
      expect(rows[0].n).toBe(0);
      await expect(
        client.query(`insert into app.${PROBE} (tenant_id, label) values ($1, 'x')`, [A]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("rollback");
      await client.end();
    }
  });
});

describe("withSystem", () => {
  test("runs as reranker_system with its reason and timeout set for the transaction only", async () => {
    const [row] = await withSystem(
      "auth.claim_free_reports",
      async (tx) =>
        (
          await tx.execute<{ login: string; reason: string; timeout: string; rows: number }>(
            sql`select current_user as login, current_setting('app.system_reason') as reason,
                       current_setting('statement_timeout') as timeout,
                       (select count(*)::int from app.tenancy_probe) as rows`,
          )
        ).rows,
      { statementTimeoutMs: 1500 },
    );
    expect(row).toEqual({
      login: "reranker_system",
      reason: "auth.claim_free_reports",
      timeout: "1500ms",
      rows: 3,
    });
  });

  test("a unique violation becomes a conflict", async () => {
    const [row] = await withSystem("test.seed", (tx) => tx.select().from(probe).limit(1));
    await expect(
      withSystem("test.seed", (tx) =>
        tx.insert(probe).values({ id: row?.id ?? "", tenantId: A, label: "dup" }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
