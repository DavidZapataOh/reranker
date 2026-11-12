import { describe, expect, test } from "vitest";
import { inRolledBackTx, withClient } from "./support.ts";

const SCHEMAS = ["app", "auth", "public_panel", "ops"] as const;

test("schemas, role groups, function and extension exist", async () => {
  await withClient("migrations", async (owner) => {
    const schemas = await owner.query<{ nspname: string }>(
      "select nspname from pg_namespace where nspname = any($1) order by 1",
      [SCHEMAS],
    );
    expect(schemas.rows.map((r) => r.nspname)).toEqual(["app", "auth", "ops", "public_panel"]);

    const roles = await owner.query(
      `select rolname, rolcanlogin, rolbypassrls, rolsuper from pg_roles
       where rolname in ('app_tenant', 'app_system') order by 1`,
    );
    expect(roles.rows).toEqual([
      { rolname: "app_system", rolcanlogin: false, rolbypassrls: false, rolsuper: false },
      { rolname: "app_tenant", rolcanlogin: false, rolbypassrls: false, rolsuper: false },
    ]);

    const fn = await owner.query(
      `select provolatile, proparallel, prorettype::regtype::text as rettype from pg_proc
       where proname = 'current_tenant_ids' and pronamespace = 'app'::regnamespace`,
    );
    expect(fn.rows).toEqual([{ provolatile: "s", proparallel: "s", rettype: "uuid[]" }]);

    const ext = await owner.query(
      "select 1 from pg_extension where extname = 'pg_stat_statements'",
    );
    expect(ext.rowCount).toBe(1);
  });
});

test("current_tenant_ids is NULL without the variable and parses a uuid[] literal", async () => {
  const a = "0196f1c2-7a3b-7cde-8f01-23456789abcd";
  const b = "0196f1c2-7a3b-7cde-8f01-23456789abce";
  await inRolledBackTx("app", async (client) => {
    const unset = await client.query("select app.current_tenant_ids()::text[] as ids");
    expect(unset.rows[0]?.ids).toBeNull();
    await client.query("select set_config('app.tenant_ids', $1, true)", [`{${a},${b}}`]);
    const set = await client.query("select app.current_tenant_ids()::text[] as ids");
    expect(set.rows[0]?.ids).toEqual([a, b]);
  });
});

describe("schema usage", () => {
  const expected: Record<string, Record<(typeof SCHEMAS)[number], boolean>> = {
    app_tenant: { app: true, public_panel: true, auth: false, ops: false },
    app_system: { app: true, public_panel: true, auth: true, ops: true },
    public: { app: false, public_panel: false, auth: false, ops: false },
  };

  test.each(Object.keys(expected))("%s", async (role) => {
    await withClient("migrations", async (owner) => {
      const result = await owner.query<{ schema: (typeof SCHEMAS)[number]; usage: boolean }>(
        "select s as schema, has_schema_privilege($1, s, 'USAGE') as usage from unnest($2::text[]) s",
        [role, SCHEMAS],
      );
      expect(Object.fromEntries(result.rows.map((r) => [r.schema, r.usage]))).toEqual(
        expected[role],
      );
    });
  });

  test("runtime roles cannot create objects in any schema", async () => {
    await withClient("migrations", async (owner) => {
      const result = await owner.query(
        `select r, s from unnest(array['app_tenant', 'app_system', 'reranker_app', 'reranker_system']) r,
           unnest($1::text[]) s where has_schema_privilege(r, s, 'CREATE')`,
        [SCHEMAS],
      );
      expect(result.rows).toEqual([]);
    });
  });
});

test("only the runtime groups may execute current_tenant_ids", async () => {
  await withClient("migrations", async (owner) => {
    const result = await owner.query(
      `select r, has_function_privilege(r, 'app.current_tenant_ids()', 'EXECUTE') as can
       from unnest(array['app_tenant', 'app_system', 'public']) r order by 1`,
    );
    expect(result.rows).toEqual([
      { r: "app_system", can: true },
      { r: "app_tenant", can: true },
      { r: "public", can: false },
    ]);
  });
});

test("default privileges give each new table exactly the grants of its schema", async () => {
  const CRUD = ["SELECT", "INSERT", "UPDATE", "DELETE"];
  const expected = {
    app: { app_tenant: CRUD, app_system: CRUD },
    public_panel: { app_tenant: ["SELECT"], app_system: CRUD },
    auth: { app_tenant: [], app_system: CRUD },
    ops: { app_tenant: [], app_system: CRUD },
  };
  await inRolledBackTx("migrations", async (owner) => {
    for (const schema of SCHEMAS) {
      await owner.query(`create table ${schema}.default_privileges_probe (id int primary key)`);
    }
    const result = await owner.query<{
      schema: keyof typeof expected;
      role: string;
      privs: string[];
    }>(
      `select s as schema, r as role,
         array(select p from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
               where has_table_privilege(r, format('%I.default_privileges_probe', s), p)) as privs
       from unnest($1::text[]) s, unnest(array['app_tenant', 'app_system']) r`,
      [SCHEMAS],
    );
    const actual: Record<string, Record<string, string[]>> = {};
    for (const { schema, role, privs } of result.rows) {
      actual[schema] = { ...actual[schema], [role]: privs };
    }
    expect(actual).toEqual(expected);

    const publicGrants = await owner.query(
      `select table_schema from information_schema.role_table_grants
       where grantee = 'PUBLIC' and table_name = 'default_privileges_probe'`,
    );
    expect(publicGrants.rows).toEqual([]);
  });
});
