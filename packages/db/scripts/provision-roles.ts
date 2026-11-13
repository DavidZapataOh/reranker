import pg from "pg";
import { directUrl } from "../src/env";

export const LOGINS = {
  reranker_app: "app_tenant",
  reranker_system: "app_system",
} as const;

export type Login = keyof typeof LOGINS;
export type LoginPasswords = Record<Login, string>;

export type ProvisionRolesOptions = {
  url: string;
  passwords: Record<string, string>;
  // Login to group; defaults to the runtime logins and only differs for throwaway roles.
  logins?: Record<string, string>;
};
export type ProvisionResult = { created: string[]; updated: string[] };

// Neon rejects SQL-created roles with weak passwords; failing here keeps that from surfacing
// as a half-provisioned branch.
const MIN_ENTROPY_BITS = 60;
const STATEMENT_TIMEOUT = "15s";
const PROVISION_LOCK = "hashtext('reranker.provision-roles')";

const names = Object.keys(LOGINS) as Login[];

function entropyBits(password: string): number {
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/\d/.test(password)) pool += 10;
  if (/[^a-zA-Z\d]/.test(password)) pool += 33;
  return [...password].length * Math.log2(pool || 1);
}

// Error messages name the offending login but never echo a value.
export function parseLoginPasswords(raw: string | undefined): LoginPasswords {
  if (!raw) throw new Error("DB_LOGIN_PASSWORDS is not set");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("DB_LOGIN_PASSWORDS must be a JSON object of login to password");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("DB_LOGIN_PASSWORDS must be a JSON object of login to password");
  }
  const entries = parsed as Record<string, unknown>;
  const unknownLogins = Object.keys(entries).filter((key) => !(key in LOGINS));
  if (unknownLogins.length > 0) {
    throw new Error(`DB_LOGIN_PASSWORDS has unknown logins: ${unknownLogins.join(", ")}`);
  }
  const passwords = {} as LoginPasswords;
  for (const name of names) {
    const value = entries[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`DB_LOGIN_PASSWORDS is missing a password for ${name}`);
    }
    passwords[name] = value;
  }
  for (const name of names) {
    if (entropyBits(passwords[name]) < MIN_ENTROPY_BITS) {
      throw new Error(`The password for ${name} has under ${MIN_ENTROPY_BITS} bits of entropy`);
    }
  }
  return passwords;
}

// Statements are composed by the server with %I/%L so Postgres itself quotes identifiers and literals.
async function run(client: pg.Client, template: string, ...args: string[]): Promise<void> {
  const { rows } = await client.query<{ statement: string }>(
    "select format($1, variadic $2::text[]) as statement",
    [template, args],
  );
  const statement = rows[0]?.statement;
  if (!statement) throw new Error("Postgres returned no statement");
  await client.query(statement);
}

// Neon only accepts plaintext passwords in CREATE/ALTER ROLE, and pg_stat_statements keeps utility
// statements verbatim, so the entries are removed as soon as the run ends, committed or not.
async function purgeStatementStats(client: pg.Client): Promise<boolean> {
  try {
    const { rows } = await client.query<{ present: boolean }>(
      "select to_regclass('pg_stat_statements') is not null as present",
    );
    if (!rows[0]?.present) return true;
    await client.query(
      `select pg_stat_statements_reset(userid, dbid, queryid) from pg_stat_statements
       where query ~* '^\\s*(create|alter)\\s+role\\M.*\\mpassword\\M'`,
    );
    return true;
  } catch {
    return false;
  }
}

type Membership = { group: string; grantor: string };

async function memberships(client: pg.Client, login: string): Promise<Membership[]> {
  const { rows } = await client.query<Membership>(
    `select g.rolname::text as "group", coalesce(gr.rolname, '')::text as grantor
     from pg_auth_members m
     join pg_roles r on r.oid = m.member
     join pg_roles g on g.oid = m.roleid
     left join pg_roles gr on gr.oid = m.grantor
     where r.rolname = $1`,
    [login],
  );
  return rows;
}

const ATTRIBUTES = {
  rolsuper: "nosuperuser",
  rolcreatedb: "nocreatedb",
  rolcreaterole: "nocreaterole",
  rolreplication: "noreplication",
  rolbypassrls: "nobypassrls",
} as const;

async function forbiddenAttributes(client: pg.Client, login: string): Promise<string[]> {
  const { rows } = await client.query<Record<string, boolean>>(
    `select ${Object.keys(ATTRIBUTES).join(", ")} from pg_roles where rolname = $1`,
    [login],
  );
  return Object.entries(rows[0] ?? {})
    .filter(([, value]) => value)
    .map(([name]) => name);
}

// Only attributes that are actually set are altered: on Neon an ALTER ROLE right after the
// CREATE ROLE of the same transaction loses the password, and clearing REPLICATION or BYPASSRLS
// needs a role holding them, which assertExact reports if the owner cannot.
async function clearAttributes(client: pg.Client, login: string): Promise<void> {
  const clauses = (await forbiddenAttributes(client, login)).map(
    (name) => ATTRIBUTES[name as keyof typeof ATTRIBUTES],
  );
  if (clauses.length > 0) await run(client, `alter role %I ${clauses.join(" ")}`, login);
}

async function assertExact(client: pg.Client, login: string, group: string): Promise<void> {
  const forbidden = await forbiddenAttributes(client, login);
  const extra = (await memberships(client, login)).filter((item) => item.group !== group);
  if (forbidden.length > 0 || extra.length > 0) {
    const groups = extra.map((item) => item.group).join(", ");
    throw new Error(
      `Login ${login} is not exact: forbidden attributes [${forbidden.join(", ")}], extra memberships [${groups}]`,
    );
  }
}

export async function provisionRoles({
  url,
  passwords,
  logins = LOGINS,
}: ProvisionRolesOptions): Promise<ProvisionResult> {
  const checked = directUrl.safeParse(url);
  if (!checked.success) {
    throw new Error(`Invalid role provisioning url: ${checked.error.issues[0]?.message}`);
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  const result: ProvisionResult = { created: [], updated: [] };
  let began = false;
  let purged = false;
  try {
    await client.connect();
    await client.query("begin");
    began = true;
    // Two runs on the same branch (parallel deploys) would otherwise race on role creation.
    await client.query(`select pg_advisory_xact_lock(${PROVISION_LOCK})`);
    for (const [login, group] of Object.entries(logins)) {
      const password = passwords[login];
      if (!password) throw new Error(`No password given for ${login}`);
      const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [login]);
      if (rowCount) {
        await run(client, "alter role %I with login password %L", login, password);
        await run(client, "grant %I to %I", group, login);
        result.updated.push(login);
      } else {
        await run(client, "create role %I login password %L in role %I", login, password, group);
        result.created.push(login);
      }
      await clearAttributes(client, login);
      for (const { group: other, grantor } of await memberships(client, login)) {
        if (other === group) continue;
        await run(client, "revoke %I from %I granted by %I", other, login, grantor);
      }
      await run(client, "alter role %I set statement_timeout = %L", login, STATEMENT_TIMEOUT);
      await assertExact(client, login, group);
    }
    await client.query("commit");
  } catch (error) {
    if (began) await client.query("rollback").catch(() => undefined);
    // Only the message is kept: driver errors can carry the failing statement.
    const code = error instanceof pg.DatabaseError ? ` (${error.code})` : "";
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Provisioning the database logins failed${code}: ${message}`);
  } finally {
    try {
      purged = await purgeStatementStats(client);
    } finally {
      await client.end();
    }
  }
  if (!purged) throw new Error("Could not purge the role statements from pg_stat_statements");
  return result;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRATIONS;
  if (!url) throw new Error("DATABASE_URL_MIGRATIONS is not set");
  const passwords = parseLoginPasswords(process.env.DB_LOGIN_PASSWORDS);
  console.log(JSON.stringify(await provisionRoles({ url, passwords })));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Provisioning failed");
    process.exitCode = 1;
  });
}
