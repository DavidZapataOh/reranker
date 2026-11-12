import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { connect, ownerUrl } from "./support/scratch-database.ts";

let owner: pg.Client;

beforeAll(async () => {
  owner = await connect(ownerUrl());
});

afterAll(async () => {
  await owner?.end();
});

const SCHEMAS = ["app", "auth", "public_panel", "ops"] as const;
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

describe("core migration", () => {
  test("creates the schemas, the group roles, the tenant function and pg_stat_statements", async () => {
    const schemas = await owner.query("select nspname from pg_namespace where nspname = any($1)", [
      SCHEMAS,
    ]);
    expect(schemas.rows.map((row) => row.nspname).sort()).toEqual([...SCHEMAS].sort());

    const roles = await owner.query(
      `select rolname, rolcanlogin, rolbypassrls, rolsuper from pg_roles
       where rolname in ('app_tenant', 'app_system') order by rolname`,
    );
    expect(roles.rows).toEqual([
      { rolname: "app_system", rolcanlogin: false, rolbypassrls: false, rolsuper: false },
      { rolname: "app_tenant", rolcanlogin: false, rolbypassrls: false, rolsuper: false },
    ]);

    const fn = await owner.query(
      `select p.provolatile, p.proparallel, p.prorettype::regtype::text as returns
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'current_tenant_ids'`,
    );
    expect(fn.rows).toEqual([{ provolatile: "s", proparallel: "s", returns: "uuid[]" }]);

    const ext = await owner.query(
      "select 1 from pg_extension where extname = 'pg_stat_statements'",
    );
    expect(ext.rowCount).toBe(1);
  });

  test("current_tenant_ids is NULL without the variable and parses a uuid[] literal", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await owner.query("begin");
    try {
      const empty = await owner.query("select app.current_tenant_ids() as ids");
      expect(empty.rows[0].ids).toBeNull();
      await owner.query("select set_config('app.tenant_ids', $1, true)", [`{${a},${b}}`]);
      const set = await owner.query("select app.current_tenant_ids()::text[] as ids");
      expect(set.rows[0].ids).toEqual([a, b]);
    } finally {
      await owner.query("rollback");
    }
    // is_local: the value dies with the transaction.
    const after = await owner.query("select app.current_tenant_ids() as ids");
    expect(after.rows[0].ids).toBeNull();
  });

  test("schema usage: app_tenant reaches app and public_panel, app_system all four, PUBLIC none", async () => {
    const expected: Record<string, readonly string[]> = {
      app_tenant: ["app", "public_panel"],
      app_system: SCHEMAS,
      public: [],
    };
    for (const [role, allowed] of Object.entries(expected)) {
      for (const schema of SCHEMAS) {
        const { rows } = await owner.query("select has_schema_privilege($1, $2, 'USAGE') as ok", [
          role,
          schema,
        ]);
        expect({ role, schema, usage: rows[0].ok }).toEqual({
          role,
          schema,
          usage: allowed.includes(schema),
        });
      }
    }
  });

  test("only the group roles may run current_tenant_ids", async () => {
    const { rows } = await owner.query(
      `select r as role, has_function_privilege(r, 'app.current_tenant_ids()', 'EXECUTE') as ok
       from unnest(array['app_tenant', 'app_system', 'public']) r`,
    );
    expect(rows).toEqual([
      { role: "app_tenant", ok: true },
      { role: "app_system", ok: true },
      { role: "public", ok: false },
    ]);
  });

  test("functions the migration owner creates later are not executable without a grant", async () => {
    await owner.query("begin");
    try {
      for (const schema of SCHEMAS) {
        await owner.query(
          `create function ${schema}.default_privileges_probe() returns int language sql as 'select 1'`,
        );
        const { rows } = await owner.query(
          `select r as role, has_function_privilege(r, $1, 'EXECUTE') as ok
           from unnest(array['app_tenant', 'app_system', 'public']) r`,
          [`${schema}.default_privileges_probe()`],
        );
        expect({ schema, rows }).toEqual({
          schema,
          rows: [
            { role: "app_tenant", ok: false },
            { role: "app_system", ok: false },
            { role: "public", ok: false },
          ],
        });
      }
    } finally {
      await owner.query("rollback");
    }
  });

  test("tables the migration owner creates get the grants of each schema", async () => {
    const expected: Record<string, Record<string, readonly string[]>> = {
      app: { app_tenant: PRIVILEGES, app_system: PRIVILEGES },
      public_panel: { app_tenant: ["SELECT"], app_system: PRIVILEGES },
      auth: { app_tenant: [], app_system: PRIVILEGES },
      ops: { app_tenant: [], app_system: PRIVILEGES },
    };
    await owner.query("begin");
    try {
      for (const schema of SCHEMAS) {
        await owner.query(`create table ${schema}.default_privileges_probe (id int)`);
        for (const [role, allowed] of Object.entries(expected[schema] ?? {})) {
          for (const privilege of PRIVILEGES) {
            const { rows } = await owner.query("select has_table_privilege($1, $2, $3) as ok", [
              role,
              `${schema}.default_privileges_probe`,
              privilege,
            ]);
            expect({ schema, role, privilege, granted: rows[0].ok }).toEqual({
              schema,
              role,
              privilege,
              granted: allowed.includes(privilege),
            });
          }
        }
        const { rows } = await owner.query(
          "select has_table_privilege('public', $1, 'SELECT') as ok",
          [`${schema}.default_privileges_probe`],
        );
        expect({ schema, public: rows[0].ok }).toEqual({ schema, public: false });
      }
    } finally {
      await owner.query("rollback");
    }
  });
});
