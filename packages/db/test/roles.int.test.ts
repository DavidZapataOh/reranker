import { getTestDatabaseUrl } from "@reranker/testing/neon";
import { expect, test } from "vitest";
import { provisionRoles } from "../scripts/provision-roles.ts";
import { withClient } from "./support.ts";

// The CI branch was provisioned before the tests with the passwords embedded in the runtime URLs, so
// reusing them keeps every other test file connected while this one reruns provisioning.
const passwordOf = (kind: "app" | "system") =>
  decodeURIComponent(new URL(getTestDatabaseUrl(kind)).password);

test("a rerun creates nothing and only updates both logins", async () => {
  const result = await provisionRoles({
    url: getTestDatabaseUrl("migrations"),
    passwords: { reranker_app: passwordOf("app"), reranker_system: passwordOf("system") },
  });
  expect(result).toEqual({ created: [], updated: ["reranker_app", "reranker_system"] });
});

test("each login belongs only to its group and holds no elevated attribute", async () => {
  await withClient("migrations", async (owner) => {
    const result = await owner.query(
      `select r.rolname, r.rolcanlogin, r.rolbypassrls, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
              array(select g.rolname from pg_auth_members m join pg_roles g on g.oid = m.roleid
                    where m.member = r.oid order by 1) as groups
       from pg_roles r where r.rolname in ('reranker_app', 'reranker_system') order by 1`,
    );
    expect(result.rows).toEqual([
      {
        rolname: "reranker_app",
        rolcanlogin: true,
        rolbypassrls: false,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        groups: ["app_tenant"],
      },
      {
        rolname: "reranker_system",
        rolcanlogin: true,
        rolbypassrls: false,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        groups: ["app_system"],
      },
    ]);
  });
});

test("logins own no relation, schema or function in the application schemas", async () => {
  await withClient("migrations", async (owner) => {
    const result = await owner.query(
      `select 'relation' as kind, c.relname as name from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('app', 'auth', 'public_panel', 'ops')
           and pg_get_userbyid(c.relowner) in ('reranker_app', 'reranker_system')
       union all
       select 'schema', nspname from pg_namespace
         where pg_get_userbyid(nspowner) in ('reranker_app', 'reranker_system')
       union all
       select 'function', proname from pg_proc
         where pg_get_userbyid(proowner) in ('reranker_app', 'reranker_system')`,
    );
    expect(result.rows).toEqual([]);
  });
});

test.each(["app", "system"] as const)(
  "the %s login connects through the pooler and carries the 15s statement_timeout",
  async (kind) => {
    expect(new URL(getTestDatabaseUrl(kind)).hostname).toMatch(/-pooler\./);
    await withClient(kind, async (client) => {
      const result = await client.query(
        "select current_user, current_setting('statement_timeout') as t",
      );
      expect(result.rows[0]).toEqual({
        current_user: kind === "app" ? "reranker_app" : "reranker_system",
        t: "15s",
      });
    });
  },
);
