import { fileURLToPath } from "node:url";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { endPools } from "../src/client";
import { type TenantId, withSystem, withTenant } from "../src/tenancy";
import { createTenant } from "./factories";
import { createScratchDatabase, type ScratchDatabase } from "./helpers";
import { onDatabase, probeStatements } from "./probe/database";
import * as probe from "./probe/money-probe.schema";

const table = probe.moneyProbe;
type Row = typeof table.$inferInsert;

let scratch: ScratchDatabase;
let tenant: TenantId;
const saved = {
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_URL_SYSTEM: process.env.DATABASE_URL_SYSTEM,
};

beforeAll(async () => {
  const pooled = { app: getTestDatabaseUrl("app"), system: getTestDatabaseUrl("system") };
  scratch = await createScratchDatabase("money");
  await runMigrations({
    url: scratch.url,
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    concurrentFolder: fileURLToPath(new URL("../migrations/concurrent", import.meta.url)),
  });
  const owner = new pg.Client({ connectionString: scratch.url });
  await owner.connect();
  try {
    for (const statement of await probeStatements(probe)) await owner.query(statement);
  } finally {
    await owner.end();
  }
  process.env.DATABASE_URL = onDatabase(pooled.app, scratch.name);
  process.env.DATABASE_URL_SYSTEM = onDatabase(pooled.system, scratch.name);
  tenant = await withSystem("test.setup", (tx) => createTenant(tx, { kind: "house" }));
}, 180_000);

afterAll(async () => {
  try {
    await endPools();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await scratch?.drop();
  }
});

const row = (over: Partial<Row> = {}): Row => ({
  tenantId: tenant,
  price_amount_minor: 14_900_000,
  price_currency: "COP",
  cost_amount_micros: 1200,
  cost_currency: "USD",
  ...over,
});

const insert = (role: "tenant" | "system", values: Row) =>
  role === "tenant"
    ? withTenant(tenant, (tx) => tx.insert(table).values(values))
    : withSystem("test.money", (tx) => tx.insert(table).values(values));

describe.each(["tenant", "system"] as const)("as the %s role", (role) => {
  test("stores a valid row and reads amounts back as numbers", async () => {
    await insert(role, row({ price_amount_minor: 14_900_001 }));
    const [stored] = await withSystem("test.money", (tx) =>
      tx.select().from(table).where(eq(table.price_amount_minor, 14_900_001)),
    );
    expect(typeof stored?.price_amount_minor).toBe("number");
    expect(stored?.price_amount_minor).toBe(14_900_001);
    expect(stored?.cost_amount_micros).toBe(1200);
  });

  test("accepts the extremes of the safe range", async () => {
    await insert(role, row({ price_amount_minor: Number.MAX_SAFE_INTEGER, cost_amount_micros: 0 }));
    await insert(role, row({ price_amount_minor: Number.MIN_SAFE_INTEGER }));
  });

  test.each([
    ["an unknown currency", { price_currency: "XXX" }],
    ["a currency outside CURRENCIES", { cost_currency: "GBP" }],
    ["an unsafe integer", { price_amount_minor: 2 ** 53 }],
    ["a negative cost", { cost_amount_micros: -1 }],
  ])("rejects %s with a check violation", async (_label, over) => {
    await expect(insert(role, row(over))).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  test("rejects a missing amount with a not-null violation", async () => {
    await expect(
      insert(role, row({ price_amount_minor: null as unknown as number })),
    ).rejects.toMatchObject({ cause: { code: "23502" } });
  });
});
