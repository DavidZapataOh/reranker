import { expect, test } from "vitest";
import { negotiateLocale } from "../src/index";

test.each([
  ["es-CO,es;q=0.9", "es-CO"],
  ["es", "es-CO"],
  ["en-US", "es-CO"],
  ["en-US,en;q=0.9,es-CO;q=0.8", "es-CO"],
  ["", "es-CO"],
  [null, "es-CO"],
  [undefined, "es-CO"],
  ["*", "es-CO"],
  ["*;q=x, ,es-", "es-CO"],
])("negotiateLocale(%j) = %s", (header, expected) => {
  expect(negotiateLocale(header)).toBe(expected);
});

// Oversized headers are cut before parsing, so a preference past the limit is ignored.
test.each([
  ["5 KB of garbage", "x".repeat(5000)],
  ["a preference after 9 KB", `${"en;q=0.1,".repeat(1000)}es-CO`],
])("%s falls back to the default locale", (_label, header) => {
  expect(negotiateLocale(header)).toBe("es-CO");
});
