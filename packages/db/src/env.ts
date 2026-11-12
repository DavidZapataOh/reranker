import { z } from "zod";

const NEON_HOST_SUFFIX = ".neon.tech";

function postgresUrl(name: string) {
  return z.string().refine(
    (value) => {
      try {
        return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: `${name} must be a postgresql:// connection string` },
  );
}

// Runtime traffic must go through Neon's PgBouncer: the direct host has ~100 connections per
// compute and would be exhausted by Fluid instances. Non-Neon hosts (local Postgres) are allowed.
function pooledUrl(name: string) {
  return postgresUrl(name).refine(
    (value) => {
      const { hostname } = new URL(value);
      return !hostname.endsWith(NEON_HOST_SUFFIX) || hostname.split(".")[0]?.endsWith("-pooler");
    },
    { message: `${name} must use the Neon -pooler host` },
  );
}

const poolMax = z
  .string()
  .regex(/^\d+$/, { message: "DB_POOL_MAX must be an integer" })
  .transform(Number)
  .pipe(z.number().int().min(1).max(20));

export const dbEnv = z.object({
  DATABASE_URL: pooledUrl("DATABASE_URL"),
  DATABASE_URL_SYSTEM: pooledUrl("DATABASE_URL_SYSTEM"),
  DATABASE_URL_MIGRATIONS: postgresUrl("DATABASE_URL_MIGRATIONS").optional(),
  DB_POOL_MAX: poolMax.optional(),
});

export type DbEnv = z.infer<typeof dbEnv>;

export function readDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  const result = dbEnv.safeParse({
    DATABASE_URL: source.DATABASE_URL,
    DATABASE_URL_SYSTEM: source.DATABASE_URL_SYSTEM,
    DATABASE_URL_MIGRATIONS: source.DATABASE_URL_MIGRATIONS || undefined,
    DB_POOL_MAX: source.DB_POOL_MAX || undefined,
  });
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.join(".");
      return issue.message.includes(key) ? issue.message : `${key}: ${issue.message}`;
    });
    throw new Error(`Invalid database environment: ${issues.join("; ")}`);
  }
  return result.data;
}
