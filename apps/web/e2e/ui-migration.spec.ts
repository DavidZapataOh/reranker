import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "@reranker/testing/playwright";

// Pixel and markup parity guard for refactors that must not change the landing. The
// baselines are never committed: capture them on the commit before the change with
// `--update-snapshots`, then run again after it.
const pages = [
  { path: "/", name: "home" },
  { path: "/terminos", name: "terms" },
  { path: "/politica-de-datos", name: "data-policy" },
  { path: "/home/cop", name: "home-cop" },
  { path: "/home/eur", name: "home-eur" },
  { path: "/home/usd", name: "home-usd" },
] as const;

// Timers and scroll reveals keep the page changing, so parity is checked in its settled state.
test.use({ reducedMotion: "reduce" });

const env = process.env.UI_BASELINE ?? "local";

// Class names are the only thing a styling refactor may legitimately rewrite; build hashes
// and inline scripts change on every build.
function normalizeHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/g, "")
    .replace(/\sclass="[^"]*"/g, "")
    .replace(/\/_next\/static\/[^"')\s]+/g, "/_next/static/*")
    .replace(/\?dpl=[\w-]+/g, "");
}

for (const { path, name } of pages) {
  test(`${name} matches the baseline`, async ({ page, gotoStable }, testInfo) => {
    await gotoStable(path);
    await expect(page).toHaveScreenshot(`${name}.png`, {
      fullPage: true,
      animations: "disabled",
      maxDiffPixels: 0,
      timeout: 20_000,
    });

    if (testInfo.project.name !== "desktop-chromium") return;
    const html = normalizeHtml(await page.content());
    const baselinePath = join("e2e", "__ui-baseline__", "html", env, `${name}.html`);
    const previous = await readFile(baselinePath, "utf8").catch(() => undefined);
    if (previous === undefined || testInfo.config.updateSnapshots === "all") {
      await mkdir(dirname(baselinePath), { recursive: true });
      await writeFile(baselinePath, html);
      return;
    }
    expect(html).toBe(previous);
  });
}
