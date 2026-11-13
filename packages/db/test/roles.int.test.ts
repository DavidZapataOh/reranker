import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { requireEnv } from "@reranker/testing/env";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { provisionRoles } from "../scripts/provision-roles";
import { createScratchDatabase, type ScratchDatabase } from "./helpers";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const concurrentFolder = fileURLToPath(new URL("../migrations/concurrent", import.meta.url));

const strongPassword = () => randomBytes(24).toString("hex");

let scratch: ScratchDatabase;
let owner: pg.Client;
const throwaways: { login: string; group: string }[] = [];

async function rows<T extends pg.QueryResultRow>(sql: string, values?: unknown[]): Promise<T[]> {
  return (await owner.query<T>(sql, values)).rows;
}

function loginUrl(login: string, password: string): string {
  const url = new URL(getTestDatabaseUrl("migrations"));
  const [endpoint = "", ...rest] = url.hostname.split(".");
  if (!endpoint.endsWith("-pooler")) url.hostname = [`${endpoint}-pooler`, ...rest].join(".");
  url.username = login;
  url.password = password;
  url.pathname = `/${scratch.name}`;
  return url.toString();
}

async function query(connectionString: string, sql: string) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return (await client.query(sql)).rows;
  } finally {
    await client.end();
  }
}

// Provisioning rewrites a login's password, and the shared logins are in use by every other
// suite at the same time, so these tests only ever read them and provision throwaway roles.
async function throwaway(options: { createGroup?: boolean } = {}) {
  const suffix = randomBytes(5).toString("hex");
  const item = { login: `probe_login_${suffix}`, group: `probe_group_${suffix}` };
  throwaways.push(item);
  if (options.createGroup !== false) await owner.query(`create role ${item.group} nologin`);
  return item;
}

async function provisioned() {
  const { login, group } = await throwaway();
  const password = strongPassword();
  const options = {
    url: scratch.url,
    logins: { [login]: group },
    passwords: { [login]: password },
  };
  return { login, group, password, options };
}

const attributeQuery = `select r.rolname, r.rolbypassrls, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
    r.rolreplication, array_agg(g.rolname::text) groups
  from pg_roles r join pg_auth_members m on m.member = r.oid join pg_roles g on g.oid = m.roleid
  where r.rolname = any($1) group by 1,2,3,4,5,6 order by 1`;

const noAttributes = {
  rolbypassrls: false,
  rolsuper: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
};

beforeAll(async () => {
  scratch = await createScratchDatabase("roles_probe");
  await runMigrations({ url: scratch.url, migrationsFolder, concurrentFolder });
  owner = new pg.Client({ connectionString: scratch.url });
  await owner.connect();
});

afterAll(async () => {
  for (const { login, group } of throwaways) {
    await owner?.query(`drop role if exists ${login}`).catch(() => undefined);
    await owner?.query(`drop role if exists ${group}`).catch(() => undefined);
  }
  await owner?.end();
  await scratch?.drop();
});

test("first run creates and the next only updates", async () => {
  const { login, options } = await provisioned();
  expect(await provisionRoles(options)).toEqual({ created: [login], updated: [] });
  expect(await provisionRoles(options)).toEqual({ created: [], updated: [login] });
});

test("memberships and attributes of a provisioned login are exact", async () => {
  const { login, group, options } = await provisioned();
  await provisionRoles(options);
  expect(await rows(attributeQuery, [[login]])).toEqual([
    { rolname: login, ...noAttributes, groups: [group] },
  ]);
});

test("the shared runtime logins are exact", async () => {
  expect(await rows(attributeQuery, [["reranker_app", "reranker_system"]])).toEqual(
    [
      ["reranker_app", "app_tenant"],
      ["reranker_system", "app_system"],
    ].map(([rolname, group]) => ({ rolname, ...noAttributes, groups: [group] })),
  );
});

test("a login with extra memberships and attributes is repaired or the run fails loudly", async () => {
  const { login, group, password, options } = await provisioned();
  const other = await throwaway();
  await owner.query(`create role ${login} login createdb in role ${other.group}`);
  await provisionRoles(options);
  expect(await query(loginUrl(login, password), "select 1 as ok")).toEqual([{ ok: 1 }]);
  expect(
    await rows(
      `select r.rolcreatedb, array_agg(g.rolname::text) groups from pg_roles r
       join pg_auth_members m on m.member = r.oid join pg_roles g on g.oid = m.roleid
       where r.rolname = $1 group by 1`,
      [login],
    ),
  ).toEqual([{ rolcreatedb: false, groups: [group] }]);
});

test("logins own no relation in app, auth, public_panel or ops", async () => {
  expect(
    await rows(
      `select c.relname from pg_class c join pg_roles r on r.oid = c.relowner
       join pg_namespace n on n.oid = c.relnamespace
       where r.rolname in ('reranker_app', 'reranker_system')
         and n.nspname in ('app', 'auth', 'public_panel', 'ops')`,
    ),
  ).toEqual([]);
});

test("a provisioned login authenticates through the pooler and gets statement_timeout 15s", async () => {
  const { login, password, options } = await provisioned();
  await provisionRoles(options);
  expect(
    await query(loginUrl(login, password), "select current_setting('statement_timeout') as t"),
  ).toEqual([{ t: "15s" }]);
});

test("the shared logins authenticate through the pooler and directly with statement_timeout 15s", async () => {
  for (const [variable, login] of [
    ["DATABASE_URL", "reranker_app"],
    ["DATABASE_URL_SYSTEM", "reranker_system"],
  ] as const) {
    const pooled = new URL(requireEnv(variable));
    const direct = new URL(pooled);
    direct.hostname = direct.hostname.replace("-pooler", "");
    for (const url of [pooled, direct]) {
      expect(
        await query(
          url.toString(),
          "select current_user, current_setting('statement_timeout') as timeout",
        ),
      ).toEqual([{ current_user: login, timeout: "15s" }]);
    }
  }
});

test("no plaintext password reaches pg_stat_statements and the stored secret is a SCRAM verifier", async () => {
  const { login, password, options } = await provisioned();
  await provisionRoles(options);
  const [count] = await rows<{ count: string }>(
    "select count(*) from pg_stat_statements where query like '%' || $1 || '%'",
    [password],
  );
  expect(count?.count).toBe("0");
  const secrets = await rows<{ rolpassword: string }>(
    "select rolpassword from pg_authid where rolname = any($1)",
    [[login, "reranker_app", "reranker_system"]],
  );
  expect(secrets).toHaveLength(3);
  for (const secret of secrets) expect(secret.rolpassword).toMatch(/^SCRAM-SHA-256\$/);
});

test("a hostile password is stored verbatim and never executed", async () => {
  const { login, group } = await throwaway();
  const password = `${strongPassword()}'; select 1; --`;
  await provisionRoles({
    url: scratch.url,
    logins: { [login]: group },
    passwords: { [login]: password },
  });
  expect(await query(loginUrl(login, password), "select 1 as ok")).toEqual([{ ok: 1 }]);
});

test("a database error does not carry the password anywhere in the error chain", async () => {
  const { login, group } = await throwaway({ createGroup: false });
  const password = `sentinel${strongPassword()}`;
  const failure = await provisionRoles({
    url: scratch.url,
    logins: { [login]: group },
    passwords: { [login]: password },
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  for (let current = failure; current instanceof Error; current = current.cause) {
    expect(current.message).not.toContain(password);
    expect(JSON.stringify(current, Object.getOwnPropertyNames(current))).not.toContain(password);
  }
  expect(await rows("select 1 from pg_roles where rolname = $1", [login])).toEqual([]);
});

test("rejects a pooler url", async () => {
  await expect(
    provisionRoles({
      url: loginUrl("reranker_app", strongPassword()),
      passwords: { reranker_app: strongPassword(), reranker_system: strongPassword() },
    }),
  ).rejects.toThrow(/direct host/);
});
