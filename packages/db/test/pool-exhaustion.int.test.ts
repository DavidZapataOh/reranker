import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { closeDatabases, database } from "../src/client.ts";
import { asTenantId, withTenant } from "../src/index.ts";
import { createProbe, dropProbe, probeTable } from "./support/probe.ts";
import { connect, ownerUrl } from "./support/scratch-database.ts";

// Each integration file runs in its own process, so this only shrinks this file's pools.
process.env.DB_POOL_MAX = "1";

const PROBE = "pool_probe";
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

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

test("with one connection held, the next transaction fails in 2.5 s with service_unavailable", async () => {
  const held = gate();
  const entered = gate();
  const holder = withTenant(A, async () => {
    entered.open();
    await held.opened;
  });
  await entered.opened;
  const started = performance.now();
  try {
    await expect(withTenant(B, async () => 1)).rejects.toMatchObject({
      code: "service_unavailable",
      retryAfterSeconds: 2,
    });
    expect(performance.now() - started).toBeLessThanOrEqual(2500);
  } finally {
    held.open();
    await holder;
  }
});

test("a withTenant nested inside another fails instead of waiting for its own connection", async () => {
  const started = performance.now();
  await expect(withTenant(A, () => withTenant(B, async () => 1))).rejects.toMatchObject({
    code: "service_unavailable",
  });
  expect(performance.now() - started).toBeLessThanOrEqual(2500);
});

test("after an RLS violation and a statement timeout the same connection starts clean", async () => {
  await expect(
    withTenant(A, (tx) => tx.insert(probe).values({ tenantId: B, label: "planted" })),
  ).rejects.toMatchObject({ code: "internal" });
  await expect(
    withTenant(A, (tx) => tx.execute(sql`select pg_sleep(1)`), { statementTimeoutMs: 100 }),
  ).rejects.toMatchObject({ code: "timeout" });

  // max 1: this runs on the client both failures used, without setting anything first.
  const { rows } = await database("app").execute<{ ids: string | null; timeout: string }>(
    sql`select current_setting('app.tenant_ids', true) as ids, current_setting('statement_timeout') as timeout`,
  );
  expect(rows[0]?.ids ?? "").toBe("");
  expect(rows[0]?.timeout).toBe("15s");
});
