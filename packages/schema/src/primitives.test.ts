import { expect, test } from "vitest";
import { Uuid } from "./primitives.ts";

const V7 = "01933b6e-7f3a-7c4e-9a1b-2c3d4e5f6a7b";

test("accepts a uuidv7 and lowercases it", () => {
  expect(Uuid.parse(V7.toUpperCase())).toBe(V7);
});

test.each(["", "x", `${V7}0`, "01933b6e7f3a7c4e9a1b2c3d4e5f6a7b"])("rejects %j", (value) => {
  expect(Uuid.safeParse(value).success).toBe(false);
});
