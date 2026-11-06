import { afterEach, expect, it, vi } from "vitest";
import { getTestDatabaseUrl } from "./neon.ts";

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["app", "DATABASE_URL"],
  ["system", "DATABASE_URL_SYSTEM"],
  ["migrations", "DATABASE_URL_MIGRATIONS"],
] as const)("maps %s to %s and fails when missing", (kind, name) => {
  vi.stubEnv(name, "postgresql://u:p@h/db");
  expect(getTestDatabaseUrl(kind)).toBe("postgresql://u:p@h/db");
  vi.stubEnv(name, "");
  expect(() => getTestDatabaseUrl(kind)).toThrow(`Missing required environment variable ${name}`);
});
