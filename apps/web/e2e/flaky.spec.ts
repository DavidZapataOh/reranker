import { expect, test } from "@playwright/test";

test("fails on the first attempt only @smoke", () => {
  expect(test.info().retry).toBeGreaterThan(0);
});
