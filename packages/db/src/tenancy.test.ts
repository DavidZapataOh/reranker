import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import {
  asTenantId,
  type TenantId,
  toPgUuidArray,
  withSystem,
  withTenant,
  withTenants,
} from "./tenancy.ts";

// No DATABASE_URL in unit tests: reaching the pool would fail with a plain configuration Error,
// so an AppError('internal') proves validation ran before any connection was requested.
const A = asTenantId("01933b6e-7f3a-7c4e-9a1b-2c3d4e5f6a7b");
const B = asTenantId("01933b6e-7f3a-7c4e-9a1b-2c3d4e5f6a7c");

test("toPgUuidArray builds a postgres array literal", () => {
  expect(toPgUuidArray([A, B])).toBe(`{${A},${B}}`);
});

test("asTenantId lowercases and rejects anything that is not a uuid", () => {
  expect(asTenantId(A.toUpperCase())).toBe(A);
  for (const bad of ["x", "", `${A},${B}`, `{${A}}`, `${A}'`]) {
    expect(() => asTenantId(bad)).toThrow(expect.objectContaining({ code: "internal" }));
  }
});

test.each([
  ["empty", []],
  ["duplicated", [A, A]],
  ["duplicated by case", [A, A.toUpperCase() as TenantId]],
  ["over 1000", Array.from({ length: 1001 }, () => asTenantId(randomUUID()))],
  ["forged", ["not-a-uuid" as TenantId]],
])("withTenants rejects a %s list before touching the pool", async (_, ids) => {
  await expect(withTenants(ids as TenantId[], async () => 1)).rejects.toMatchObject({
    code: "internal",
  });
});

test("withTenant validates its id too", async () => {
  await expect(withTenant("x" as TenantId, async () => 1)).rejects.toMatchObject({
    code: "internal",
  });
});

test.each(["", "Auth", "a", "auth claim", `a${"b".repeat(64)}`, "1auth"])(
  "withSystem rejects the reason %j",
  async (reason) => {
    await expect(withSystem(reason, async () => 1)).rejects.toMatchObject({ code: "internal" });
  },
);

test.each([0, -1, 1.5, 60_001, Number.NaN])("rejects statementTimeoutMs %d", async (ms) => {
  await expect(withTenant(A, async () => 1, { statementTimeoutMs: ms })).rejects.toMatchObject({
    code: "internal",
  });
  await expect(withSystem("auth", async () => 1, { statementTimeoutMs: ms })).rejects.toMatchObject(
    { code: "internal" },
  );
});
