import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  asTenantId,
  type TenantId,
  toPgUuidArray,
  withSystem,
  withTenant,
  withTenants,
} from "./tenancy.ts";

// No database variables exist in the unit project: any test that reached the pool would throw
// "Invalid database environment" instead of the validation error asserted here.
const A = asTenantId("0195f1c2-7d3a-7c4b-9e5f-0a1b2c3d4e5f");
const B = asTenantId("0195f1c2-7d3a-7c4b-9e5f-0a1b2c3d4e60");

describe("tenant ids", () => {
  test("toPgUuidArray builds a postgres array literal", () => {
    expect(toPgUuidArray([A, B])).toBe(`{${A},${B}}`);
  });

  test("asTenantId lowercases and rejects non-uuid input", () => {
    expect(asTenantId(A.toUpperCase())).toBe(A);
    for (const bad of ["x", "", `${A}x`, `{${A}}`, `${A},${B}`]) {
      expect(() => asTenantId(bad)).toThrow(expect.objectContaining({ code: "internal" }));
    }
  });
});

describe("withTenants validation", () => {
  test.each([
    ["an empty list", []],
    ["a duplicate", [A, A]],
    ["a duplicate that differs only in case", [A, A.toUpperCase() as TenantId]],
    ["more than 1,000 ids", Array.from({ length: 1001 }, () => randomUUID() as TenantId)],
    ["a forged id", ["not-a-uuid" as TenantId]],
  ])("rejects %s before touching the pool", async (_label, ids) => {
    await expect(withTenants(ids, async () => 1)).rejects.toMatchObject({ code: "internal" });
  });

  test("rejects a statement timeout that is not a positive integer", async () => {
    for (const statementTimeoutMs of [0, -1, 1.5, Number.NaN]) {
      await expect(withTenant(A, async () => 1, { statementTimeoutMs })).rejects.toMatchObject({
        code: "internal",
      });
    }
  });
});

describe("withSystem validation", () => {
  test.each(["", "a", "Auth", "1auth", "auth claim", "auth;drop", "a".repeat(65)])(
    "rejects the reason %j",
    async (reason) => {
      await expect(withSystem(reason, async () => 1)).rejects.toMatchObject({ code: "internal" });
    },
  );
});
