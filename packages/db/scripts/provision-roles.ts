import pg from "pg";
import { directUrl } from "../src/env";

export const LOGINS = {
  reranker_app: "app_tenant",
  reranker_system: "app_system",
} as const;

export type Login = keyof typeof LOGINS;
export type LoginPasswords = Record<Login, string>;

export type ProvisionRolesOptions = { url: string; passwords: LoginPasswords };
export type ProvisionResult = { created: string[]; updated: string[] };

// Neon rejects SQL-created roles with weak passwords; failing here keeps that from surfacing
// as a half-provisioned branch.
const MIN_ENTROPY_BITS = 60;
const STATEMENT_TIMEOUT = "15s";

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
  const unknown_ = Object.keys(entries).filter((key) => !(key in LOGINS));
  if (unknown_.length > 0) {
    throw new Error(`DB_LOGIN_PASSWORDS has unknown logins: ${unknown_.join(", ")}`);
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

// Statements are composed by the server with %I/%L so the password is quoted by Postgres itself.
async function run(client: pg.Client, template: string, ...args: string[]): Promise<void> {
  const { rows } = await client.query<{ statement: string }>(
    "select format($1, variadic $2::text[]) as statement",
    [template, args],
  );
  await client.query(rows[0]?.statement ?? "");
}

export async function provisionRoles({
  url,
  passwords,
}: ProvisionRolesOptions): Promise<ProvisionResult> {
  const checked = directUrl.safeParse(url);
  if (!checked.success) {
    throw new Error(`Invalid role provisioning url: ${checked.error.issues[0]?.message}`);
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  await client.connect();
  const result: ProvisionResult = { created: [], updated: [] };
  try {
    await client.query("begin");
    for (const login of names) {
      const group = LOGINS[login];
      const password = passwords[login];
      const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [login]);
      if (rowCount) {
        await run(client, "alter role %I with login password %L", login, password);
        await run(client, "grant %I to %I", group, login);
        result.updated.push(login);
      } else {
        await run(client, "create role %I login password %L in role %I", login, password, group);
        result.created.push(login);
      }
      // A login in the other group would silently widen its access.
      for (const other of Object.values(LOGINS).filter((name) => name !== group)) {
        await run(client, "revoke %I from %I", other, login);
      }
      await run(client, "alter role %I set statement_timeout = %L", login, STATEMENT_TIMEOUT);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    // Driver errors can carry the failing statement, which contains a password.
    const code = error instanceof pg.DatabaseError ? ` (${error.code})` : "";
    throw new Error(
      `Provisioning the database logins failed${code}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    await client.end();
  }
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
