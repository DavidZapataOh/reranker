import pg from "pg";

// Closed list: identifiers are never taken from input.
const LOGINS = { reranker_app: "app_tenant", reranker_system: "app_system" } as const;
export type Login = keyof typeof LOGINS;
export type LoginPasswords = Record<Login, string>;

// Same floor Neon enforces for roles created through SQL.
const MIN_ENTROPY_BITS = 60;
const CHARACTER_CLASSES = [
  { pattern: /[a-z]/, size: 26 },
  { pattern: /[A-Z]/, size: 26 },
  { pattern: /[0-9]/, size: 10 },
  { pattern: /[^a-zA-Z0-9]/, size: 33 },
];

export function passwordEntropyBits(password: string): number {
  const pool = CHARACTER_CLASSES.filter(({ pattern }) => pattern.test(password)).reduce(
    (sum, { size }) => sum + size,
    0,
  );
  return pool === 0 ? 0 : password.length * Math.log2(pool);
}

export function parseLoginPasswords(raw: string | undefined): LoginPasswords {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    throw new Error("DB_LOGIN_PASSWORDS must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("DB_LOGIN_PASSWORDS must be a JSON object");
  }
  const entries = parsed as Record<string, unknown>;
  const unknown = Object.keys(entries).filter((key) => !(key in LOGINS));
  if (unknown.length > 0)
    throw new Error(`DB_LOGIN_PASSWORDS has unknown logins: ${unknown.join(", ")}`);
  const passwords = {} as LoginPasswords;
  for (const login of Object.keys(LOGINS) as Login[]) {
    const password = entries[login];
    if (typeof password !== "string") throw new Error(`DB_LOGIN_PASSWORDS is missing ${login}`);
    if (!/^[\x21-\x7e]+$/.test(password)) {
      throw new Error(`DB_LOGIN_PASSWORDS: ${login} must be printable ASCII without spaces`);
    }
    if (passwordEntropyBits(password) < MIN_ENTROPY_BITS) {
      throw new Error(`DB_LOGIN_PASSWORDS: ${login} has under ${MIN_ENTROPY_BITS} bits of entropy`);
    }
    passwords[login] = password;
  }
  return passwords;
}

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
      const role = client.escapeIdentifier(login);
      const groupRole = client.escapeIdentifier(group);
      const password = client.escapeLiteral(opts.passwords[login]);
      const exists = await client.query("select 1 from pg_roles where rolname = $1", [login]);
      if (exists.rowCount === 0) {
        await client.query(
          `create role ${role} with login password ${password} in role ${groupRole}`,
        );
        created.push(login);
      } else {
        await client.query(`alter role ${role} with login password ${password}`);
        await client.query(`grant ${groupRole} to ${role}`);
        updated.push(login);
      }
      // A safety net under the per-transaction timeout that withTenant/withSystem set.
      await client.query(`alter role ${role} set statement_timeout = '15s'`);
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

if (import.meta.main) {
  try {
    const url = process.env.DATABASE_URL_MIGRATIONS;
    if (url === undefined || url === "") throw new Error("DATABASE_URL_MIGRATIONS is required");
    const passwords = parseLoginPasswords(process.env.DB_LOGIN_PASSWORDS);
    console.log(JSON.stringify(await provisionRoles({ url, passwords })));
  } catch (error) {
    // pg errors never echo statement text, so the passwords cannot reach the log through this message.
    console.error("Provisioning failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
