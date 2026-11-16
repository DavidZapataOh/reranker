import { beforeEach, expect, test, vi } from "vitest";

const telemetry = vi.hoisted(() => ({ sendOpsAlert: vi.fn() }));
vi.mock("@reranker/telemetry", () => telemetry);

const { routeDbEvent } = await import("./db-alerts");

beforeEach(() => telemetry.sendOpsAlert.mockReset().mockResolvedValue(undefined));

test.each([
  ["db_rls_violation", "db-rls-violation"],
  ["db_pool_exhausted", "db-pool-exhausted"],
  ["db_compute_unavailable", "neon-quota"],
] as const)("routes %s to the %s alert", (name, kind) => {
  routeDbEvent({ name, pool: "app" });
  expect(telemetry.sendOpsAlert).toHaveBeenCalledWith(kind, { pool: "app" });
});

test("carries the pg code and the system reason, and omits what is absent", () => {
  routeDbEvent({ name: "db_rls_violation", pool: "system", pgCode: "42501", reason: "ops.alert" });
  expect(telemetry.sendOpsAlert).toHaveBeenCalledWith("db-rls-violation", {
    pool: "system",
    pgCode: "42501",
    reason: "ops.alert",
  });
});
