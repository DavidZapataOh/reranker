import { expect, test } from "vitest";
import { cx } from "./cx.ts";

test("joins the truthy parts with a space", () => {
  expect(cx("a", false, null, undefined, "b")).toBe("a b");
});

test("returns an empty string without parts", () => {
  expect(cx()).toBe("");
});
