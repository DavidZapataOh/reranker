import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { provisionRoles } from "../scripts/provision-roles";
import { createScratchDatabase, type ScratchDatabase } from "./helpers";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const concurrentFolder = fileURLToPath(new URL("../migrations/concurrent", import.meta.url));

const passwords = {
  reranker_app: randomBytes(24).toString("hex"),
  reranker_system: randomBytes(24).toString("hex"),
};

let scratch: ScratchDatabase;
let owner: pg.Client;
const first = {} as Awaited<ReturnType<typeof provisionRoles>>;

async function rows<T extends pg.QueryResultRow>(sql: string, values?: unknown[]): Promise<T[]> {
  return (await owner.query<T>(sql, values)).rows;
}

// Logins connect through the pooler in production; the host is derived from the owner url.
function loginUrl(login: keyof typeof passwords, pooled: boolean): string {
  const url = new URL(getTestDatabaseUrl("migrations"));
  const [endpoint = "", ...rest] = url.hostname.split(".");
  if (pooled && !endpoint.endsWith("-pooler"))
    url.hostname = [`${endpoint}-pooler`, ...rest].join(".");
  url.username = login;
  url.password = passwords[login];
  url.pathname = `/${scratch.name}`;
  return url.toString();
}

async function asLogin(login: keyof typeof passwords, sql: string, pooled = true) {
  const client = new pg.Client({ connectionString: loginUrl(login, pooled) });
  await client.connect();
  try {
    return (await client.query(sql)).rows;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  scratch = await createScratchDatabase("roles_probe");
  await runMigrations({ url: scratch.url, migrationsFolder, concurrentFolder });
  owner = new pg.Client({ connectionString: scratch.url });
  await owner.connect();
  // The logins are cluster-wide, so remove leftovers to observe a true first run.
  for (const login of Object.keys(passwords)) {
    await owner.query(`drop owned by ${login}`).catch(() => undefined);
    await owner.query(`drop role if exists ${login}`);
  }
  Object.assign(first, await provisionRoles({ url: scratch.url, passwords }));
});

afterAll(async () => {
  await owner?.end();
  await scratch?.drop();
});

test("two runs: first creates, second only updates; memberships and attributes are exact", async () => {
  expect(first.created).toEqual(["reranker_app", "reranker_system"]);
  expect(first.updated).toEqual([]);
  const second = await provisionRoles({ url: scratch.url, passwords });
  expect(second).toEqual({ created: [], updated: ["reranker_app", "reranker_system"] });

  expect(
    await rows(`select r.rolname, r.rolbypassrls, r.rolsuper, r.rolcreaterole, array_agg(g.rolname::text) groups
      from pg_roles r join pg_auth_members m on m.member = r.oid join pg_roles g on g.oid = m.roleid
      where r.rolname in ('reranker_app', 'reranker_system') group by 1,2,3,4 order by 1`),
  ).toEqual([
    {
      rolname: "reranker_app",
      rolbypassrls: false,
      rolsuper: false,
      rolcreaterole: false,
      groups: ["app_tenant"],
    },
    {
      rolname: "reranker_system",
      rolbypassrls: false,
      rolsuper: false,
      rolcreaterole: false,
      groups: ["app_system"],
    },
  ]);
});

test("a login moved into the wrong group is put back", async () => {
  await owner.query("grant app_system to reranker_app");
  await provisionRoles({ url: scratch.url, passwords });
  expect(
    await rows(
      `select g.rolname from pg_auth_members m join pg_roles r on r.oid = m.member
       join pg_roles g on g.oid = m.roleid where r.rolname = 'reranker_app'`,
    ),
  ).toEqual([{ rolname: "app_tenant" }]);
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

test("both logins connect through the -pooler host and get statement_timeout 15s", async () => {
  for (const login of ["reranker_app", "reranker_system"] as const) {
    expect(await asLogin(login, "show statement_timeout")).toEqual([{ statement_timeout: "15s" }]);
    expect(await asLogin(login, "select current_user", false)).toEqual([{ current_user: login }]);
  }
});

test("rejects a pooler url and keeps passwords out of errors", async () => {
  const pooler = new URL(loginUrl("reranker_app", true));
  await expect(provisionRoles({ url: pooler.toString(), passwords })).rejects.toThrow(
    /direct host/,
  );
  const bad = { ...passwords, reranker_app: `${passwords.reranker_app}'; select 1; --` };
  await provisionRoles({ url: scratch.url, passwords: bad });
  expect(await asLogin("reranker_system", "select 1 as ok")).toEqual([{ ok: 1 }]);
  await provisionRoles({ url: scratch.url, passwords });
});
