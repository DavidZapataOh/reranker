import { expect, test, vi } from "vitest";
import { asTenantId, type TenantId, toPgUuidArray, withSystem, withTenants } from "./tenancy.ts";

vi.mock("./client.ts", () => ({
  getPool: () => {
    throw new Error("the pool must not be touched");
  },
}));

const A = asTenantId("0196f1c2-7a3b-7cde-8f01-23456789abcd");
const B = asTenantId("0196f1c2-7a3b-7cde-8f01-23456789abce");

test("toPgUuidArray builds a postgres array literal", () => {
  expect(toPgUuidArray([A, B])).toBe(`{${A},${B}}`);
});

test("asTenantId lowercases and rejects non-uuid input", () => {
  expect(asTenantId(A.toUpperCase())).toBe(A);
  expect(() => asTenantId("x")).toThrow(expect.objectContaining({ code: "internal" }));
  expect(() => asTenantId(`${A},${B}`)).toThrow(expect.objectContaining({ code: "internal" }));
});

const many = Array.from(
  { length: 1001 },
  (_, i) => `0196f1c2-7a3b-7cde-8f01-${i.toString(16).padStart(12, "0")}` as TenantId,
);

test.each([
  ["empty", []],
  ["duplicate", [A, A]],
  ["duplicate by case", [A, A.toUpperCase() as TenantId]],
  ["over 1000", many],
  ["cast non-uuid", ["{a}" as TenantId]],
])("withTenants rejects %s ids before touching the pool", async (_label, ids) => {
  await expect(withTenants(ids, async () => 1)).rejects.toMatchObject({ code: "internal" });
});

test.each([0, -1, 1.5, 60_001])("rejects statementTimeoutMs %s", async (statementTimeoutMs) => {
  await expect(withTenants([A], async () => 1, { statementTimeoutMs })).rejects.toMatchObject({
    code: "internal",
  });
});

test.each(["", "A", "x", "has space", "drop;table", "a".repeat(65)])(
  "withSystem rejects reason %j",
  async (reason) => {
    await expect(withSystem(reason, async () => 1)).rejects.toMatchObject({ code: "internal" });
  },
);
