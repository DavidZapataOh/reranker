import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runMigrations } from "../scripts/migrate";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const concurrentFolder = fileURLToPath(new URL("../migrations/concurrent", import.meta.url));

const SCHEMAS = ["app", "auth", "public_panel", "ops"] as const;

let databaseName: string;
let client: pg.Client;

async function adminClient(): Promise<pg.Client> {
  const admin = new pg.Client({ connectionString: getTestDatabaseUrl("migrations") });
  await admin.connect();
  return admin;
}

// The group roles are cluster-wide and shared with other databases, so the database is
// disposable but the roles are never dropped.
beforeAll(async () => {
  databaseName = `core_probe_${randomBytes(6).toString("hex")}`;
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
});

afterAll(async () => {
  await client?.end();
  const admin = await adminClient();
  try {
    await admin.query(`drop database if exists ${databaseName} with (force)`);
  } finally {
    await admin.end();
  }
});

async function rows<T extends pg.QueryResultRow>(sql: string, values?: unknown[]): Promise<T[]> {
  return (await client.query<T>(sql, values)).rows;
}

test("schemas, roles, function and extension exist", async () => {
  const schemas = await rows<{ nspname: string }>("select nspname from pg_namespace");
  expect(schemas.map((row) => row.nspname)).toEqual(expect.arrayContaining([...SCHEMAS]));

  expect(
    await rows(
      "select rolname, rolcanlogin from pg_roles where rolname in ('app_tenant','app_system') order by rolname",
    ),
  ).toEqual([
    { rolname: "app_system", rolcanlogin: false },
    { rolname: "app_tenant", rolcanlogin: false },
  ]);

  expect(
    await rows(
      `select provolatile, proparallel, prorettype::regtype::text as prorettype
         from pg_proc where proname = 'current_tenant_ids' and pronamespace = 'app'::regnamespace`,
    ),
  ).toEqual([{ provolatile: "s", proparallel: "s", prorettype: "uuid[]" }]);

  const extensions = await rows<{ extname: string }>("select extname from pg_extension");
  expect(extensions.map((row) => row.extname)).toContain("pg_stat_statements");
});

test("current_tenant_ids is NULL without the variable and parses a uuid[] literal", async () => {
  const a = "0199c1a2-0000-7000-8000-00000000000a";
  const b = "0199c1a2-0000-7000-8000-00000000000b";
  await client.query("begin");
  try {
    expect(await rows("select app.current_tenant_ids() as ids")).toEqual([{ ids: null }]);
    await client.query("select set_config('app.tenant_ids', $1, true)", [`{${a},${b}}`]);
    expect(await rows("select app.current_tenant_ids() as ids")).toEqual([{ ids: [a, b] }]);
    await client.query("select set_config('app.tenant_ids', '', true)");
    expect(await rows("select app.current_tenant_ids() as ids")).toEqual([{ ids: null }]);
  } finally {
    await client.query("rollback");
  }
});

test("schema usage grants: app_tenant → app, public_panel only; app_system → all four; PUBLIC → none", async () => {
  const usage = async (role: string) => {
    const result: Record<string, boolean | undefined> = {};
    for (const schema of SCHEMAS) {
      const [row] = await rows<{ ok: boolean }>(
        "select has_schema_privilege($1, $2, 'USAGE') as ok",
        [role, schema],
      );
      result[schema] = row?.ok;
    }
    return result;
  };
  expect(await usage("app_tenant")).toEqual({
    app: true,
    auth: false,
    public_panel: true,
    ops: false,
  });
  expect(await usage("app_system")).toEqual({
    app: true,
    auth: true,
    public_panel: true,
    ops: true,
  });
  expect(await usage("public")).toEqual({
    app: false,
    auth: false,
    public_panel: false,
    ops: false,
  });
});

test("current_tenant_ids is executable by both groups and not by PUBLIC", async () => {
  const can = async (role: string) =>
    (
      await rows<{ ok: boolean }>(
        "select has_function_privilege($1, 'app.current_tenant_ids()', 'EXECUTE') as ok",
        [role],
      )
    )[0]?.ok;
  expect(await can("app_tenant")).toBe(true);
  expect(await can("app_system")).toBe(true);
  expect(await can("public")).toBe(false);
});

test("default privileges: a table created by the owner in each schema gets the intended grants", async () => {
  const crud = ["SELECT", "INSERT", "UPDATE", "DELETE"];
  const expected: Record<string, Record<string, string[]>> = {
    app: { app_tenant: crud, app_system: crud },
    public_panel: { app_tenant: ["SELECT"], app_system: crud },
    auth: { app_tenant: [], app_system: crud },
    ops: { app_tenant: [], app_system: crud },
  };
  await client.query("begin");
  try {
    for (const schema of SCHEMAS) {
      await client.query(`create table ${schema}.grant_probe (id integer primary key)`);
      for (const role of ["app_tenant", "app_system"]) {
        const granted: string[] = [];
        for (const privilege of crud) {
          const [row] = await rows<{ ok: boolean }>(
            "select has_table_privilege($1, $2, $3) as ok",
            [role, `${schema}.grant_probe`, privilege],
          );
          if (row?.ok) granted.push(privilege);
        }
        expect({ schema, role, granted }).toEqual({
          schema,
          role,
          granted: expected[schema]?.[role],
        });
      }
    }
  } finally {
    await client.query("rollback");
  }
});
