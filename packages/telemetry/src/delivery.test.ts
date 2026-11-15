import { expect, test, vi } from "vitest";

const db = vi.hoisted(() => ({
  execute: vi.fn(),
  withSystem: vi.fn(),
}));

vi.mock("@reranker/db", () => ({ withSystem: db.withSystem }));

const { claimDelivery } = await import("./delivery");

function run(rows: unknown[]) {
  db.execute.mockReset().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows });
  db.withSystem.mockImplementation((_reason, fn) => fn({ execute: db.execute }));
}

test("claims under the ops.alert system reason after taking the advisory lock", async () => {
  run([{ kind: "uptime-down" }]);
  await expect(claimDelivery("uptime-down", new Date("2026-11-14T15:20:00Z"))).resolves.toBe(true);
  expect(db.withSystem).toHaveBeenCalledWith("ops.alert", expect.any(Function));
  expect(db.execute).toHaveBeenCalledTimes(2);
});

test("a conflict or a reached cap inserts nothing and refuses the claim", async () => {
  run([]);
  await expect(claimDelivery("uptime-down")).resolves.toBe(false);
});
