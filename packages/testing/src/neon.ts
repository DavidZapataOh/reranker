import { requireEnv } from "./env.ts";

export const VARIABLES = {
  app: "DATABASE_URL",
  system: "DATABASE_URL_SYSTEM",
  migrations: "DATABASE_URL_MIGRATIONS",
} as const;

export type DatabaseKind = keyof typeof VARIABLES;

export function getTestDatabaseUrl(kind: DatabaseKind): string {
  return requireEnv(VARIABLES[kind]);
}
