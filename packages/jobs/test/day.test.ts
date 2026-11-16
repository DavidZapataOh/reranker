import { expect, test } from "vitest";
import { nextResetAt, spendDay } from "../src/day";

test("spend day and reset follow the country day", () => {
  expect(spendDay(new Date("2026-11-06T04:59:59Z"))).toBe("2026-11-05");
  expect(spendDay(new Date("2026-11-06T05:00:00Z"))).toBe("2026-11-06");
  expect(nextResetAt(new Date("2026-11-05T15:00:00Z")).toISOString()).toBe(
    "2026-11-06T05:00:00.000Z",
  );
});

test("the reset is strictly after the instant that sits on a boundary", () => {
  expect(nextResetAt(new Date("2026-11-06T05:00:00Z")).toISOString()).toBe(
    "2026-11-07T05:00:00.000Z",
  );
  expect(nextResetAt(new Date("2026-11-06T04:59:59Z")).toISOString()).toBe(
    "2026-11-06T05:00:00.000Z",
  );
});

test("the reset crosses month and year ends", () => {
  expect(nextResetAt(new Date("2026-12-31T20:00:00Z")).toISOString()).toBe(
    "2027-01-01T05:00:00.000Z",
  );
  expect(spendDay(new Date("2028-03-01T04:00:00Z"))).toBe("2028-02-29");
});

test("defaults to now", () => {
  expect(spendDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(nextResetAt().getTime()).toBeGreaterThan(Date.now());
});
