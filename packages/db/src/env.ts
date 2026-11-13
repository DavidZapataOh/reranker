import { z } from "@reranker/schema";

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

const isNeonPooler = (value: string) => {
  const { hostname } = new URL(value);
  return hostname.endsWith(".neon.tech") && hostname.split(".")[0]?.endsWith("-pooler") === true;
};
const isNeon = (value: string) => new URL(value).hostname.endsWith(".neon.tech");

// Neon's transaction-mode pooler is the only safe path for serverless runtimes; the checks are
// scoped to neon.tech so a local Postgres still works in development.
const pooledUrl = postgresUrl.refine((value) => !isNeon(value) || isNeonPooler(value), {
  error: "must use the pooler host (ep-*-pooler)",
});

// Migrations hold a session advisory lock; through the transaction-mode pooler the unlock can
// land on another server connection and leave the lock held, blocking every later deploy.
export const directUrl = postgresUrl.refine((value) => !isNeonPooler(value), {
  error: "must use the direct host, not the pooler",
});

export const dbEnv = z.object({
  DATABASE_URL: pooledUrl,
  DATABASE_URL_SYSTEM: pooledUrl,
  DATABASE_URL_MIGRATIONS: directUrl.optional(),
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
