import { expect, test } from "vitest";
import { registerSchema, z } from "../src/index";

test("registers a schema under its id in z.globalRegistry", () => {
  const S = registerSchema("TestThing", z.object({ a: z.string() }));
  expect(z.globalRegistry.get(S)?.id).toBe("TestThing");
});

test("rejects a duplicate id", () => {
  registerSchema("TestDup", z.string());
  expect(() => registerSchema("TestDup", z.number())).toThrow("Duplicate schema id: TestDup");
});

test("rejects ids that are not PascalCase", () => {
  expect(() => registerSchema("money", z.string())).toThrow("Schema id must be PascalCase: money");
});

test("rejects a one-character id", () => {
  expect(() => registerSchema("A", z.string())).toThrow("Schema id must be PascalCase: A");
});
