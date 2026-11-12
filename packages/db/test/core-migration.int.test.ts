import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { ownerUrl, withClient } from "./support.ts";

const SCHEMAS = ["app", "auth", "public_panel", "ops"] as const;
const CRUD = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

describe("core migration", () => {
  test("creates the schemas, group roles, tenant function and statistics extension", async () => {
    await withClient(ownerUrl(), async (c) => {
      const schemas = await c.query<{ nspname: string }>(
        "select nspname from pg_namespace where nspname = any($1) order by nspname",
        [SCHEMAS],
      );
      expect(schemas.rows.map((r) => r.nspname)).toEqual(["app", "auth", "ops", "public_panel"]);

      const roles = await c.query(
        `select rolname, rolcanlogin, rolbypassrls from pg_roles
          where rolname in ('app_tenant', 'app_system') order by rolname`,
      );
      expect(roles.rows).toEqual([
        { rolname: "app_system", rolcanlogin: false, rolbypassrls: false },
        { rolname: "app_tenant", rolcanlogin: false, rolbypassrls: false },
      ]);

      const fn = await c.query(
        `select p.provolatile, p.proparallel, p.prorettype::regtype::text as rettype
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and p.proname = 'current_tenant_ids'`,
      );
      expect(fn.rows).toEqual([{ provolatile: "s", proparallel: "s", rettype: "uuid[]" }]);

      const ext = await c.query("select 1 from pg_extension where extname = 'pg_stat_statements'");
      expect(ext.rowCount).toBe(1);
    });
  });

  test("current_tenant_ids is NULL without the variable and parses the uuid[] literal", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await withClient(ownerUrl(), async (c) => {
      await c.query("begin");
      const unset = await c.query("select app.current_tenant_ids() as ids");
      expect(unset.rows[0].ids).toBeNull();
      await c.query("select set_config('app.tenant_ids', $1, true)", [`{${a},${b}}`]);
      const set = await c.query("select app.current_tenant_ids()::text[] as ids");
      expect(set.rows[0].ids).toEqual([a, b]);
      await c.query("rollback");
      // After the transaction the setting exists but is empty, which must still read as NULL.
      const after = await c.query("select app.current_tenant_ids() as ids");
      expect(after.rows[0].ids).toBeNull();
    });
  });

  test("only the group roles may execute current_tenant_ids", async () => {
    await withClient(ownerUrl(), async (c) => {
      const { rows } = await c.query(
        `select r as role, has_function_privilege(r, 'app.current_tenant_ids()', 'EXECUTE') as allowed
           from unnest(array['app_tenant', 'app_system', 'public']) r`,
      );
      expect(rows).toEqual([
        { role: "app_tenant", allowed: true },
        { role: "app_system", allowed: true },
        { role: "public", allowed: false },
      ]);
    });
  });

  test("schema usage: app_tenant on app and public_panel, app_system on all four, PUBLIC on none", async () => {
    await withClient(ownerUrl(), async (c) => {
      const { rows } = await c.query<{ role: string; schema: string; usage: boolean }>(
        `select r as role, s as schema, has_schema_privilege(r, s, 'USAGE') as usage
           from unnest(array['app_tenant', 'app_system', 'public']) r, unnest($1::text[]) s`,
        [SCHEMAS],
      );
      const usage = (role: string) =>
        rows.filter((row) => row.role === role && row.usage).map((row) => row.schema);
      expect(usage("app_tenant")).toEqual(["app", "public_panel"]);
      expect(usage("app_system")).toEqual([...SCHEMAS]);
      expect(usage("public")).toEqual([]);
    });
  });

  test("tables the owner creates get the default grants of their schema", async () => {
    const expected: Record<string, Record<string, readonly string[]>> = {
      app: { app_tenant: CRUD, app_system: CRUD, public: [] },
      public_panel: { app_tenant: ["SELECT"], app_system: CRUD, public: [] },
      auth: { app_tenant: [], app_system: CRUD, public: [] },
      ops: { app_tenant: [], app_system: CRUD, public: [] },
    };
    await withClient(ownerUrl(), async (c) => {
      await c.query("begin");
      try {
        for (const schema of SCHEMAS) {
          await c.query(`create table ${schema}.default_grants_probe (id uuid primary key)`);
          const { rows } = await c.query<{ role: string; privilege: string; granted: boolean }>(
            `select r as role, p as privilege, has_table_privilege(r, $1, p) as granted
               from unnest(array['app_tenant', 'app_system', 'public']) r, unnest($2::text[]) p`,
            [`${schema}.default_grants_probe`, CRUD],
          );
          const granted = Object.fromEntries(
            ["app_tenant", "app_system", "public"].map((role) => [
              role,
              rows.filter((r) => r.role === role && r.granted).map((r) => r.privilege),
            ]),
          );
          expect(granted, schema).toEqual(expected[schema]);
        }
      } finally {
        await c.query("rollback");
      }
    });
  });
});
