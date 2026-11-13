import { z } from "@reranker/schema";

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

// Neon's transaction-mode pooler is the only safe path for serverless runtimes; the check is
// scoped to neon.tech so a local Postgres still works in development.
const pooledUrl = postgresUrl.refine(
  (value) => {
    const { hostname } = new URL(value);
    return !hostname.endsWith(".neon.tech") || hostname.split(".")[0]?.endsWith("-pooler") === true;
  },
  { error: "must use the pooler host (ep-*-pooler)" },
);

export const dbEnv = z.object({
  DATABASE_URL: pooledUrl,
  DATABASE_URL_SYSTEM: pooledUrl,
  DATABASE_URL_MIGRATIONS: postgresUrl.optional(),
  DB_POOL_MAX: z
    .string()
    .regex(/^\d+$/, "must be an integer")
    .transform(Number)
    .pipe(z.int().min(1).max(20))
    .optional(),
});

export type DbEnv = z.infer<typeof dbEnv>;

export function readDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  const parsed = dbEnv.safeParse(source);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid database environment: ${detail}`);
}
