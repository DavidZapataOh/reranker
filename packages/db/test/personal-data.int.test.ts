import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { PERSONAL_DATA } from "../src/personal-data";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const concurrentFolder = fileURLToPath(new URL("../migrations/concurrent", import.meta.url));

const SUSPICIOUS = /(^|_)(email|phone|name|ip_address|user_agent|document_number)($|_)/;

// Suspicious by name but not personal: teams are named by the product, not by people.
const NOT_PERSONAL = new Set(["auth.teams.name"]);

const inventoried = new Set(
  PERSONAL_DATA.map((entry) => `${entry.schema}.${entry.table}.${entry.column}`),
);

let databaseName: string;
let client: pg.Client;

async function adminClient(): Promise<pg.Client> {
  const admin = new pg.Client({ connectionString: getTestDatabaseUrl("migrations") });
  await admin.connect();
  return admin;
}

// A disposable database keeps the rolled-back DDL away from tables other test files use.
beforeAll(async () => {
  databaseName = `personal_data_${randomBytes(6).toString("hex")}`;
  const admin = await adminClient();
  try {
    await admin.query(`create database ${databaseName}`);
  } finally {
    await admin.end();
  }
  const url = new URL(getTestDatabaseUrl("migrations"));
  url.pathname = `/${databaseName}`;
  await runMigrations({ url: url.toString(), migrationsFolder, concurrentFolder });
  client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client?.end();
  const admin = await adminClient();
  try {
    await admin.query(`drop database if exists ${databaseName} with (force)`);
  } finally {
    await admin.end();
  }
});

// Base tables only: views and indexes carry no data of their own.
async function columns(schemas: string[]): Promise<string[]> {
  const { rows } = await client.query<{ key: string }>(
    `select n.nspname || '.' || c.relname || '.' || a.attname as key
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid and c.relkind in ('r', 'p')
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any ($1) and a.attnum > 0 and not a.attisdropped
      order by 1`,
    [schemas],
  );
  return rows.map((row) => row.key);
}

const suspicious = (all: string[]) =>
  all.filter((key) => SUSPICIOUS.test(key.split(".")[2] ?? "") && !NOT_PERSONAL.has(key));
const uninventoried = (all: string[]) => suspicious(all).filter((key) => !inventoried.has(key));

test("every suspicious column in app and auth is inventoried", async () => {
  expect(uninventoried(await columns(["app", "auth"]))).toEqual([]);
});

test("no suspicious column exists in public_panel or ops", async () => {
  expect(suspicious(await columns(["public_panel", "ops"]))).toEqual([]);
});

test("every PERSONAL_DATA entry points to an existing column", async () => {
  const existing = new Set(await columns(["app", "auth"]));
  expect([...inventoried].filter((key) => !existing.has(key))).toEqual([]);
  for (const entry of PERSONAL_DATA) {
    expect(entry.purpose.trim()).not.toBe("");
    expect(entry.retention.trim()).not.toBe("");
  }
});

describe("mutation: an uninventoried personal column fails the gate by name", () => {
  test.each([
    ["create table app.gate_pd (id uuid primary key, email text)", "app.gate_pd.email"],
    ["alter table auth.members add column phone text", "auth.members.phone"],
    [
      "create table public_panel.gate_pd (id uuid primary key, name text)",
      "public_panel.gate_pd.name",
    ],
    ["create table ops.gate_pd (id uuid primary key, ip_address inet)", "ops.gate_pd.ip_address"],
  ])("rolled-back %s makes the check fail naming %s", async (ddl, column) => {
    await client.query("begin");
    try {
      await client.query(ddl);
      const found = [
        ...uninventoried(await columns(["app", "auth"])),
        ...suspicious(await columns(["public_panel", "ops"])),
      ];
      expect(found).toEqual([column]);
    } finally {
      await client.query("rollback");
    }
    expect(await columns(["app", "auth", "public_panel", "ops"])).not.toContain(column);
  });
});
