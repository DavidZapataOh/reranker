import { getTestDatabaseUrl } from "@reranker/testing/neon";
import { describe, expect, test } from "vitest";
import { provisionRoles } from "../scripts/provision-roles.ts";
import { ownerUrl, passwordOf, withClient } from "./support.ts";

// CI provisions the logins before the suites run; reusing their passwords keeps the other
// suites connected while this one re-runs the provisioning.
const passwords = () => ({
  reranker_app: passwordOf(getTestDatabaseUrl("app")),
  reranker_system: passwordOf(getTestDatabaseUrl("system")),
});

describe("provisionRoles", () => {
  test("is idempotent: re-running only updates the existing logins", async () => {
    const opts = { url: ownerUrl(), passwords: passwords() };
    const expected = { created: [], updated: ["reranker_app", "reranker_system"] };
    await expect(provisionRoles(opts)).resolves.toEqual(expected);
    await expect(provisionRoles(opts)).resolves.toEqual(expected);
  });

  test("each login belongs only to its group and can never bypass row level security", async () => {
    await withClient(ownerUrl(), async (c) => {
      const { rows } = await c.query(
        `select r.rolname, r.rolcanlogin, r.rolbypassrls, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
                array(select g.rolname::text from pg_auth_members m join pg_roles g on g.oid = m.roleid
                       where m.member = r.oid order by 1) as groups,
                exists(select from pg_roles g
                        where g.oid <> r.oid and pg_has_role(r.oid, g.oid, 'MEMBER')
                          and (g.rolbypassrls or g.rolsuper)) as inherits_bypass
           from pg_roles r where r.rolname in ('reranker_app', 'reranker_system') order by 1`,
      );
      const login = { rolcanlogin: true, rolbypassrls: false, rolsuper: false };
      const limited = { rolcreaterole: false, rolcreatedb: false, inherits_bypass: false };
      expect(rows).toEqual([
        { rolname: "reranker_app", ...login, ...limited, groups: ["app_tenant"] },
        { rolname: "reranker_system", ...login, ...limited, groups: ["app_system"] },
      ]);
    });
  });

  test("the logins own no relation, schema or function", async () => {
    await withClient(ownerUrl(), async (c) => {
      const { rows } = await c.query(
        `select 'relation' as kind, c.oid::regclass::text as name from pg_class c
           join pg_roles r on r.oid = c.relowner where r.rolname in ('reranker_app', 'reranker_system')
         union all
         select 'schema', n.nspname::text from pg_namespace n
           join pg_roles r on r.oid = n.nspowner where r.rolname in ('reranker_app', 'reranker_system')
         union all
         select 'function', p.oid::regprocedure::text from pg_proc p
           join pg_roles r on r.oid = p.proowner where r.rolname in ('reranker_app', 'reranker_system')`,
      );
      expect(rows).toEqual([]);
    });
  });

  test.each([
    ["app", "reranker_app"],
    ["system", "reranker_system"],
  ] as const)(
    "the %s login connects through its runtime url with a 15s statement timeout",
    async (kind, login) => {
      await withClient(getTestDatabaseUrl(kind), async (c) => {
        const { rows } = await c.query(
          "select current_user as login, current_setting('statement_timeout') as timeout",
        );
        expect(rows).toEqual([{ login, timeout: "15s" }]);
      });
    },
  );
});
