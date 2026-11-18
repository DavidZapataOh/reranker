import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { version } = createRequire(import.meta.url)("@playwright/test/package.json") as {
  version: string;
};
const workflow = readFileSync(
  new URL("../../../.github/workflows/quality.yml", import.meta.url),
  "utf8",
);

// The image only holds the browsers of its own release; any other Playwright finds no executable
// and every deployment would fail its tests.
it("runs deployment tests in the digest-pinned image of the installed Playwright", () => {
  const images = [...workflow.matchAll(/^\s*image:\s*(\S+)$/gm)].map(([, image]) =>
    image?.replace(/@sha256:[0-9a-f]{64}$/, "@sha256"),
  );

  expect(images).toEqual([`mcr.microsoft.com/playwright:v${version}-noble@sha256`]);
});
