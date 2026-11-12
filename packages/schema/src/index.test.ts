import { expect, test } from "vitest";
import * as schema from "./index.ts";

test("the entry point exposes z, Uuid and the error primitives", () => {
  expect(Object.keys(schema).sort()).toEqual(
    ["AppError", "ERRORS", "ERROR_CODES", "Uuid", "isAppError", "z"].sort(),
  );
  expect(schema.z.string().parse("a")).toBe("a");
});
