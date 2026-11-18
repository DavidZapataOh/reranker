import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("the package refuses client bundles", () =>
  expect(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")).toMatch(
    /^import "server-only";/,
  ));
