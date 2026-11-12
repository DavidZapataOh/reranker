import { z } from "@reranker/schema";

// Runtime traffic must go through Neon's PgBouncer (-pooler host); other hosts are local Postgres.
const pooledUrl = (name: string) =>
  z.url().refine(
    (value) => {
      const host = new URL(value).hostname;
      return !host.endsWith(".neon.tech") || (host.split(".")[0] ?? "").endsWith("-pooler");
    },
    { message: `${name} must use the Neon pooler host (-pooler)` },
  );

export const dbEnv = z.object({
  DATABASE_URL: pooledUrl("DATABASE_URL"),
  DATABASE_URL_SYSTEM: pooledUrl("DATABASE_URL_SYSTEM"),
  DATABASE_URL_MIGRATIONS: z.url().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).optional(),
});

export type DbEnv = z.infer<typeof dbEnv>;

export function readDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  const result = dbEnv.safeParse({
    DATABASE_URL: source.DATABASE_URL,
    DATABASE_URL_SYSTEM: source.DATABASE_URL_SYSTEM,
    DATABASE_URL_MIGRATIONS: source.DATABASE_URL_MIGRATIONS,
    DB_POOL_MAX: source.DB_POOL_MAX,
  });
  if (!result.success) {
    // Values are connection strings with passwords: report only the variable and the rule.
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid database environment: ${issues.join("; ")}`);
  }
  return result.data;
}
