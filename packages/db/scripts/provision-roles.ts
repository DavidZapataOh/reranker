import pg from "pg";

/** Each runtime login and the group that holds its grants and policies. */
const LOGINS = { reranker_app: "app_tenant", reranker_system: "app_system" } as const;

type Login = keyof typeof LOGINS;
export type LoginPasswords = Record<Login, string>;

// Neon's own floor for roles created with SQL.
const MIN_ENTROPY_BITS = 60;
const SAFETY_STATEMENT_TIMEOUT = "15s";

const CLASSES = [
  { pattern: /[a-z]/, size: 26 },
  { pattern: /[A-Z]/, size: 26 },
  { pattern: /[0-9]/, size: 10 },
  { pattern: /[^a-zA-Z0-9]/, size: 33 },
];

export function passwordEntropyBits(password: string): number {
  const pool = CLASSES.filter(({ pattern }) => pattern.test(password)).reduce(
    (sum, { size }) => sum + size,
    0,
  );
  return pool === 0 ? 0 : password.length * Math.log2(pool);
}

/** Parses DB_LOGIN_PASSWORDS. Errors name the login, never the password. */
export function parseLoginPasswords(raw: string | undefined): LoginPasswords {
  if (raw === undefined || raw === "") throw new Error("DB_LOGIN_PASSWORDS is required");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("DB_LOGIN_PASSWORDS must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('DB_LOGIN_PASSWORDS must be an object like {"reranker_app": "…"}');
  }
  const entries = parsed as Record<string, unknown>;
  const unknownLogins = Object.keys(entries).filter((key) => !(key in LOGINS));
  if (unknownLogins.length > 0) {
    throw new Error(`DB_LOGIN_PASSWORDS has unknown logins: ${unknownLogins.join(", ")}`);
  }
  const passwords = {} as LoginPasswords;
  for (const login of Object.keys(LOGINS) as Login[]) {
    const password = entries[login];
    if (typeof password !== "string") {
      throw new Error(`DB_LOGIN_PASSWORDS needs a string password for ${login}`);
    }
    if (passwordEntropyBits(password) < MIN_ENTROPY_BITS) {
      throw new Error(
        `The password for ${login} has less than ${MIN_ENTROPY_BITS} bits of entropy`,
      );
    }
    passwords[login] = password;
  }
  return passwords;
}

export type ProvisionResult = { created: Login[]; updated: Login[] };

/**
 * Creates or resets the runtime logins. Runs as the project owner over the direct connection.
 * Logins created with SQL do not join neon_superuser, so they never bypass RLS.
 */
export async function provisionRoles(options: {
  url: string;
  passwords: LoginPasswords;
}): Promise<ProvisionResult> {
  const client = new pg.Client({
    connectionString: options.url,
    application_name: "reranker-provision-roles",
    connectionTimeoutMillis: 30_000,
  });
  await client.connect();
  const result: ProvisionResult = { created: [], updated: [] };
  try {
    await client.query("begin");
    for (const [login, group] of Object.entries(LOGINS) as [Login, string][]) {
      const { rows } = await client.query<{ exists: boolean }>(
        "select exists (select from pg_roles where rolname = $1) as exists",
        [login],
      );
      const exists = rows[0]?.exists === true;
      // DDL takes no bind parameters; format() quotes on the server so the password is never
      // spliced into SQL on this side. Neon only accepts plaintext passwords (no SCRAM verifiers).
      const statements = exists
        ? [
            ["alter role %I with login password %L", login, options.passwords[login]],
            ["grant %I to %I", group, login],
          ]
        : [
            [
              "create role %I with login password %L in role %I",
              login,
              options.passwords[login],
              group,
            ],
          ];
      statements.push([
        "alter role %I set statement_timeout = %L",
        login,
        SAFETY_STATEMENT_TIMEOUT,
      ]);
      for (const [template, ...args] of statements) {
        await execFormatted(client, template as string, args as string[]);
      }
      result[exists ? "updated" : "created"].push(login);
    }
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function execFormatted(client: pg.Client, template: string, args: string[]): Promise<void> {
  const placeholders = args.map((_, index) => `$${index + 2}::text`).join(", ");
  const { rows } = await client.query<{ statement: string }>(
    `select format($1, ${placeholders}) as statement`,
    [template, ...args],
  );
  const statement = rows[0]?.statement;
  if (statement === undefined) throw new Error("format() returned no statement");
  await client.query(statement);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRATIONS;
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL_MIGRATIONS is required to provision roles");
  }
  const passwords = parseLoginPasswords(process.env.DB_LOGIN_PASSWORDS);
  console.log(JSON.stringify(await provisionRoles({ url, passwords })));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // Only the message: driver errors can carry the connection string or the statement.
    console.error(
      `db:provision-roles failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exit(1);
  });
}
