import pg from "pg";
import { z } from "zod";

// Closed list: identifiers are never taken from input.
export const LOGINS = { reranker_app: "app_tenant", reranker_system: "app_system" } as const;
export type Login = keyof typeof LOGINS;
export type LoginPasswords = Record<Login, string>;

// Neon's own floor for SQL-created role passwords.
const MIN_ENTROPY_BITS = 60;
// Safety net for anything that runs outside withTenant/withSystem, which set their own limit.
const LOGIN_STATEMENT_TIMEOUT = "15s";

const passwordsSchema = z
  .object({ reranker_app: z.string(), reranker_system: z.string() })
  .strict();

export function passwordEntropyBits(password: string): number {
  const alphabet =
    (/[a-z]/.test(password) ? 26 : 0) +
    (/[A-Z]/.test(password) ? 26 : 0) +
    (/[0-9]/.test(password) ? 10 : 0) +
    (/[^a-zA-Z0-9]/.test(password) ? 33 : 0);
  return alphabet === 0 ? 0 : password.length * Math.log2(alphabet);
}

export function parseLoginPasswords(raw: string | undefined): LoginPasswords {
  if (!raw) throw new Error("Missing required environment variable DB_LOGIN_PASSWORDS");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("DB_LOGIN_PASSWORDS must be a JSON object of login to password");
  }
  const result = passwordsSchema.safeParse(json);
  if (!result.success) {
    const keys = result.error.issues.map((issue) => issue.path.join(".") || "root");
    throw new Error(`DB_LOGIN_PASSWORDS is invalid for: ${keys.join(", ")}`);
  }
  for (const login of Object.keys(LOGINS) as Login[]) {
    if (passwordEntropyBits(result.data[login]) < MIN_ENTROPY_BITS) {
      throw new Error(`${login} password has less than ${MIN_ENTROPY_BITS} bits of entropy`);
    }
  }
  return result.data;
}

// Runs on the direct owner connection. Logins created by SQL never join neon_superuser, so they
// carry no BYPASSRLS and stay subject to row level security.
export async function provisionRoles(opts: {
  url: string;
  passwords: LoginPasswords;
}): Promise<{ created: Login[]; updated: Login[] }> {
  const client = new pg.Client({ connectionString: opts.url });
  await client.connect();
  const created: Login[] = [];
  const updated: Login[] = [];
  try {
    await client.query("begin");
    for (const [login, group] of Object.entries(LOGINS) as [Login, string][]) {
      const password = opts.passwords[login];
      const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [login]);
      if (rowCount === 0) {
        await execFormatted(client, "create role %I with login password %L in role %I", [
          login,
          password,
          group,
        ]);
        created.push(login);
      } else {
        await execFormatted(client, "alter role %I with login password %L", [login, password]);
        await execFormatted(client, "grant %I to %I", [group, login]);
        updated.push(login);
      }
      await execFormatted(client, "alter role %I set statement_timeout = %L", [
        login,
        LOGIN_STATEMENT_TIMEOUT,
      ]);
    }
    await client.query("commit");
    return { created, updated };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

// Role DDL takes no bind parameters; quoting happens server-side with format() so the password
// never passes through client-side string building.
async function execFormatted(client: pg.Client, template: string, args: string[]): Promise<void> {
  const placeholders = args.map((_, i) => `$${i + 2}::text`).join(", ");
  const { rows } = await client.query<{ statement: string }>(
    `select format($1, ${placeholders}) as statement`,
    [template, ...args],
  );
  const statement = rows[0]?.statement;
  if (!statement) throw new Error("Could not build role statement");
  await client.query(statement);
}

if (import.meta.main) {
  try {
    const url = process.env.DATABASE_URL_MIGRATIONS;
    if (!url) throw new Error("Missing required environment variable DATABASE_URL_MIGRATIONS");
    const passwords = parseLoginPasswords(process.env.DB_LOGIN_PASSWORDS);
    console.log(JSON.stringify(await provisionRoles({ url, passwords })));
  } catch (error) {
    console.error(`Provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
