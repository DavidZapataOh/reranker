import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { version } = createRequire(import.meta.url)("@playwright/test/package.json") as {
  version: string;
};

function images(workflow: string): string[] {
  const source = readFileSync(
    new URL(`../../../.github/workflows/${workflow}`, import.meta.url),
    "utf8",
  );
  return [...source.matchAll(/^\s*image:\s*(\S+)$/gm)].map(([, image]) =>
    (image ?? "").replace(/@sha256:[0-9a-f]{64}$/, "@sha256"),
  );
}

// The image only holds the browsers of its own release; any other Playwright finds no executable
// and every deployment, or every component test run, would fail.
it.each(["quality.yml", "ci.yml"])(
  "%s runs Playwright in the digest-pinned image of the installed version",
  (workflow) => {
    expect(images(workflow)).toEqual([`mcr.microsoft.com/playwright:v${version}-noble@sha256`]);
  },
);
