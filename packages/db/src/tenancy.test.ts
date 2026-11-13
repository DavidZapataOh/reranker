import { randomUUID } from "node:crypto";
import { expect, expectTypeOf, test, vi } from "vitest";
import {
  asTenantId,
  type SystemTx,
  type TenantId,
  type TenantTx,
  toPgUuidArray,
  withSystem,
  withTenant,
  withTenants,
} from "./tenancy";

// Every case here must fail validation before a connection is requested.
vi.mock("./client", () => {
  const touched = () => {
    throw new Error("pool touched");
  };
  return { appDb: touched, systemDb: touched };
});

const A = asTenantId(randomUUID());
const B = asTenantId(randomUUID());

test("toPgUuidArray builds a postgres array literal", () => {
  expect(toPgUuidArray([A, B])).toBe(`{${A},${B}}`);
});

test("asTenantId lowercases and rejects non-uuid input", () => {
  expect(asTenantId(A.toUpperCase())).toBe(A);
  for (const bad of ["x", "", `${A},${B}`, `{${A}}`, ` ${A}`]) {
    expect(() => asTenantId(bad)).toThrow(expect.objectContaining({ code: "internal" }));
  }
});

test.each([
  ["empty", []],
  ["duplicate", [A, A]],
  ["duplicate after normalizing", [A, asTenantId(A.toUpperCase())]],
  ["duplicate in another case", [A, A.toUpperCase() as TenantId]],
  ["unbranded garbage", [A, `${B}}` as TenantId]],
  ["over 1000", Array.from({ length: 1001 }, () => asTenantId(randomUUID()))],
])("withTenants rejects %s before touching the pool", async (_, ids) => {
  await expect(withTenants(ids as TenantId[], async () => 1)).rejects.toMatchObject({
    code: "internal",
  });
});

test("withTenant rejects an unbranded malformed id", async () => {
  await expect(withTenant("nope" as TenantId, async () => 1)).rejects.toMatchObject({
    code: "internal",
  });
});

test.each(["", "a", "Auth", "1auth", "auth reports", `a${"b".repeat(64)}`, "auth;drop"])(
  "withSystem rejects the reason %j",
  async (reason) => {
    await expect(withSystem(reason, async () => 1)).rejects.toMatchObject({ code: "internal" });
  },
);

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects statementTimeoutMs %s, which would disable or break the per-transaction timeout",
  async (statementTimeoutMs) => {
    await expect(withTenant(A, async () => 1, { statementTimeoutMs })).rejects.toMatchObject({
      code: "internal",
    });
    await expect(
      withSystem("jobs.lease", async () => 1, { statementTimeoutMs }),
    ).rejects.toMatchObject({
      code: "internal",
    });
  },
);

test("tenant and system transactions are distinct nominal types", () => {
  expectTypeOf<TenantTx>().not.toExtend<SystemTx>();
  expectTypeOf<SystemTx>().not.toExtend<TenantTx>();
  expectTypeOf<string>().not.toExtend<TenantId>();
});
