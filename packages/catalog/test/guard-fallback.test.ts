import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { guardFallback, type Recording } from "../scripts/guard-fallback.ts";

const recorded = (language: string) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/recorded/generation/generation-${language}.json`, import.meta.url),
      "utf8",
    ),
  ) as Recording;

// Real output of both providers for the five local seed categories (generation-record workflow).
// Before the German word lists, 291 of 660 paraphrases failed as names and two of five sets fell
// back to templates.
test("recorded German paraphrases lose none to the name guard and no set falls back", () => {
  const result = guardFallback(recorded("de"));
  expect(result.paraphrases).toBe(660);
  expect(result.rejected.proper_name ?? 0).toBe(0);
  expect(result.fallbacks).toBe(0);
});
