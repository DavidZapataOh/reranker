import { getTestDatabaseUrl } from "@reranker/testing/neon";
import type pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { provisionRoles } from "../scripts/provision-roles.ts";
import { connect, ownerUrl } from "./support/scratch-database.ts";

let owner: pg.Client;

beforeAll(async () => {
  owner = await connect(ownerUrl());
});

afterAll(async () => {
  await owner?.end();
});

// The CI job provisioned these logins already; reusing their current passwords keeps the other
// test files connected while this one runs provisioning again.
const passwords = {
  reranker_app: decodeURIComponent(new URL(getTestDatabaseUrl("app")).password),
  reranker_system: decodeURIComponent(new URL(getTestDatabaseUrl("system")).password),
};

test("a second run only updates, and memberships and attributes stay exact", async () => {
  const again = await provisionRoles({ url: ownerUrl(), passwords });
  expect(again).toEqual({ created: [], updated: ["reranker_app", "reranker_system"] });

  // The owner ran those statements, so it sees their full text in pg_stat_statements if kept.
  const leaked = await owner.query(
    "select count(*)::int as n from pg_stat_statements where strpos(query, $1) > 0 or strpos(query, $2) > 0",
    [passwords.reranker_app, passwords.reranker_system],
  );
  expect(leaked.rows[0].n).toBe(0);

  const { rows } = await owner.query(
    `select r.rolname, r.rolcanlogin, r.rolbypassrls, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
            array_agg(g.rolname order by g.rolname)::text[] as groups
     from pg_roles r
     join pg_auth_members m on m.member = r.oid
     join pg_roles g on g.oid = m.roleid
     where r.rolname in ('reranker_app', 'reranker_system')
     group by 1, 2, 3, 4, 5, 6
     order by 1`,
  );
  const attributes = {
    rolcanlogin: true,
    rolbypassrls: false,
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
  };
  // Membership in neon_superuser would bring BYPASSRLS; the exact group list rules it out.
  expect(rows).toEqual([
    { rolname: "reranker_app", ...attributes, groups: ["app_tenant"] },
    { rolname: "reranker_system", ...attributes, groups: ["app_system"] },
  ]);
});

test("no runtime login owns a relation, schema or function in the product schemas", async () => {
  const { rows } = await owner.query(
    `select kind, name from (
       select 'relation' as kind, n.nspname || '.' || c.relname as name, c.relowner as owner
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('app', 'auth', 'public_panel', 'ops')
       union all
       select 'schema', nspname, nspowner from pg_namespace
       where nspname in ('app', 'auth', 'public_panel', 'ops')
       union all
       select 'function', n.nspname || '.' || p.proname, p.proowner
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('app', 'auth', 'public_panel', 'ops')
     ) owned
     join pg_roles r on r.oid = owned.owner
     where r.rolname in ('reranker_app', 'reranker_system', 'app_tenant', 'app_system')`,
  );
  expect(rows).toEqual([]);
});

test.each([
  ["app", "reranker_app"],
  ["system", "reranker_system"],
] as const)(
  "the %s login connects through the pooler with a 15s statement timeout",
  async (kind, login) => {
    const url = getTestDatabaseUrl(kind);
    expect(new URL(url).hostname.split(".")[0]).toMatch(/-pooler$/);
    const client = await connect(url);
    try {
      const { rows } = await client.query(
        "select current_user as login, current_setting('statement_timeout') as timeout",
      );
      expect(rows).toEqual([{ login, timeout: "15s" }]);
    } finally {
      await client.end();
    }
  },
);
