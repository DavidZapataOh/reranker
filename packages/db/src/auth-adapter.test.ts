import { afterEach, expect, test, vi } from "vitest";
import { endPools, systemPool } from "./client";

afterEach(async () => {
  await endPools();
  vi.unstubAllEnvs();
});

// The first import transforms the whole schema and Drizzle under coverage: about 2 s alone, past
// 5 s on a runner shared with every other package's tests.
test("importing the adapter reads no environment and opens no pool", async () => {
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("DATABASE_URL_SYSTEM", undefined);
  const { authDb } = await import("./auth-adapter");
  expect(authDb).toBeDefined();
}, 30_000);

test("authDb runs on the shared system pool once used", async () => {
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://reranker_app:x@ep-a-pooler.us-east-1.aws.neon.tech/neondb?sslmode=verify-full",
  );
  vi.stubEnv(
    "DATABASE_URL_SYSTEM",
    "postgresql://reranker_system:x@ep-a-pooler.us-east-1.aws.neon.tech/neondb?sslmode=verify-full",
  );
  const { authDb } = await import("./auth-adapter");
  expect((authDb as unknown as { $client: unknown }).$client).toBe(systemPool());
  expect(typeof authDb.select).toBe("function");
});
