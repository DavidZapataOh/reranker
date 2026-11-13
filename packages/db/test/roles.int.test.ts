import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runMigrations } from "../scripts/migrate";
import {
  type LoginPasswords,
  parseLoginPasswords,
  provisionRoles,
} from "../scripts/provision-roles";
import { createScratchDatabase, type ScratchDatabase } from "./helpers";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const concurrentFolder = fileURLToPath(new URL("../migrations/concurrent", import.meta.url));

const strongPassword = () => randomBytes(24).toString("hex");

// The logins are shared with every other suite and the CI job's own urls, so the passwords in the
// environment are reused as they are; only a local run without them makes up new ones.
// Without the variable in CI the suite would rotate the shared logins away from the job's urls.
if (process.env.CI && !process.env.DB_LOGIN_PASSWORDS) {
  throw new Error("DB_LOGIN_PASSWORDS must be exported to the test steps in CI");
}
const passwords: LoginPasswords = process.env.DB_LOGIN_PASSWORDS
  ? parseLoginPasswords(process.env.DB_LOGIN_PASSWORDS)
  : { reranker_app: strongPassword(), reranker_system: strongPassword() };

let scratch: ScratchDatabase;
let owner: pg.Client;
const throwaways: { login: string; group: string }[] = [];

async function rows<T extends pg.QueryResultRow>(sql: string, values?: unknown[]): Promise<T[]> {
  return (await owner.query<T>(sql, values)).rows;
}

function loginUrl(login: string, password: string, pooled: boolean): string {
  const url = new URL(getTestDatabaseUrl("migrations"));
  const [endpoint = "", ...rest] = url.hostname.split(".");
  if (pooled && !endpoint.endsWith("-pooler")) {
    url.hostname = [`${endpoint}-pooler`, ...rest].join(".");
  }
  url.username = login;
  url.password = password;
  url.pathname = `/${scratch.name}`;
  return url.toString();
}

async function asLogin(login: string, password: string, sql: string, pooled = true) {
  const client = new pg.Client({ connectionString: loginUrl(login, password, pooled) });
  await client.connect();
  try {
    return (await client.query(sql)).rows;
  } finally {
    await client.end();
  }
}

// Throwaway logins and groups keep creation, repair and hostile-input cases away from the
// shared roles; the real group roles are never touched.
async function throwaway(options: { createGroup?: boolean } = {}) {
  const suffix = randomBytes(5).toString("hex");
  const item = { login: `probe_login_${suffix}`, group: `probe_group_${suffix}` };
  throwaways.push(item);
  if (options.createGroup !== false) await owner.query(`create role ${item.group} nologin`);
  return item;
}

beforeAll(async () => {
  scratch = await createScratchDatabase("roles_probe");
  await runMigrations({ url: scratch.url, migrationsFolder, concurrentFolder });
  owner = new pg.Client({ connectionString: scratch.url });
  await owner.connect();
  await provisionRoles({ url: scratch.url, passwords });
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
  const { login, group } = await throwaway();
  const options = {
    url: scratch.url,
    logins: { [login]: group },
    passwords: { [login]: strongPassword() },
  };
  expect(await provisionRoles(options)).toEqual({ created: [login], updated: [] });
  expect(await provisionRoles(options)).toEqual({ created: [], updated: [login] });
});

test("memberships and attributes of the runtime logins are exact", async () => {
  expect(await provisionRoles({ url: scratch.url, passwords })).toEqual({
    created: [],
    updated: ["reranker_app", "reranker_system"],
  });
  expect(
    await rows(`select r.rolname, r.rolbypassrls, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
        array_agg(g.rolname::text) groups
      from pg_roles r join pg_auth_members m on m.member = r.oid join pg_roles g on g.oid = m.roleid
      where r.rolname in ('reranker_app', 'reranker_system') group by 1,2,3,4,5,6 order by 1`),
  ).toEqual(
    [
      ["reranker_app", "app_tenant"],
      ["reranker_system", "app_system"],
    ].map(([rolname, group]) => ({
      rolname,
      rolbypassrls: false,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      groups: [group],
    })),
  );
});

test("a login with extra memberships and attributes is repaired or the run fails loudly", async () => {
  const { login, group } = await throwaway();
  const other = await throwaway();
  await owner.query(`create role ${login} login createdb in role ${other.group}`);
  const password = strongPassword();
  await provisionRoles({
    url: scratch.url,
    logins: { [login]: group },
    passwords: { [login]: password },
  });
  expect(await asLogin(login, password, "select 1 as ok")).toEqual([{ ok: 1 }]);
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

test("both logins authenticate with the plaintext through the pooler and get statement_timeout 15s", async () => {
  for (const login of ["reranker_app", "reranker_system"] as const) {
    expect(await asLogin(login, passwords[login], "show statement_timeout")).toEqual([
      { statement_timeout: "15s" },
    ]);
    expect(await asLogin(login, passwords[login], "select current_user", false)).toEqual([
      { current_user: login },
    ]);
  }
});

test("no plaintext password reaches pg_stat_statements and the stored secret is a SCRAM verifier", async () => {
  await provisionRoles({ url: scratch.url, passwords });
  for (const password of Object.values(passwords)) {
    const [count] = await rows<{ count: string }>(
      "select count(*) from pg_stat_statements where query like '%' || $1 || '%'",
      [password],
    );
    expect(count?.count).toBe("0");
  }
  const secrets = await rows<{ rolpassword: string }>(
    "select rolpassword from pg_authid where rolname in ('reranker_app', 'reranker_system')",
  );
  expect(secrets).toHaveLength(2);
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
  expect(await asLogin(login, password, "select 1 as ok")).toEqual([{ ok: 1 }]);
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
    provisionRoles({ url: loginUrl("reranker_app", passwords.reranker_app, true), passwords }),
  ).rejects.toThrow(/direct host/);
});
