import { z } from "@reranker/schema";

const POSTGRES_PROTOCOL = /^postgres(ql)?$/;

const postgresUrl = z.url({ protocol: POSTGRES_PROTOCOL });

// Runtime traffic must go through PgBouncer: Postgres on the smallest Neon compute only takes 104
// direct connections. Local Postgres has no pooler host, so the rule only applies to Neon.
const pooledUrl = postgresUrl.refine(
  (value) => {
    const host = new URL(value).hostname;
    return !host.endsWith(".neon.tech") || host.split(".")[0]?.endsWith("-pooler") === true;
  },
  { message: "must use the Neon pooler host (-pooler)" },
);

export const dbEnv = z.object({
  DATABASE_URL: pooledUrl,
  DATABASE_URL_SYSTEM: pooledUrl,
  DATABASE_URL_MIGRATIONS: postgresUrl.optional(),
  DB_POOL_MAX: z
    .string()
    .regex(/^\d+$/, { message: "must be an integer" })
    .transform(Number)
    .pipe(z.number().int().min(1).max(20))
    .optional(),
});

export type DbEnv = z.infer<typeof dbEnv>;

export function readDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  const result = dbEnv.safeParse({
    DATABASE_URL: source.DATABASE_URL,
    DATABASE_URL_SYSTEM: source.DATABASE_URL_SYSTEM,
    DATABASE_URL_MIGRATIONS: source.DATABASE_URL_MIGRATIONS,
    DB_POOL_MAX: source.DB_POOL_MAX,
  });
  if (result.success) {
    return Object.fromEntries(
      Object.entries(result.data).filter(([, value]) => value !== undefined),
    ) as DbEnv;
  }
  // Issue messages never include the input, so connection strings stay out of logs.
  const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  throw new Error(`Invalid database environment. ${issues.join("; ")}`);
}
