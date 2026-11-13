import type { Page } from "@playwright/test";
import { expect, test } from "@reranker/testing/playwright";

// Layout must hold whether the web fonts arrive late or never: next/font's metric-adjusted
// fallbacks are what keep the swap from moving content.

// The hero demo types its answer on a timer; reduced motion fills it in at once.
test.use({ reducedMotion: "reduce" });

const fonts = "**/_next/static/media/**";

type Shift = { start: number; value: number; hadRecentInput: boolean };

// Installed before any page script so no shift escapes, however early it happens.
async function recordShifts(page: Page) {
  await page.addInitScript(() => {
    const shifts: Shift[] = [];
    Object.assign(window, { __shifts: shifts });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & Shift)[]) {
        shifts.push({
          start: entry.startTime,
          value: entry.value,
          hadRecentInput: entry.hadRecentInput,
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

const clsSince = (page: Page, since: number) =>
  page.evaluate(
    (after: number) =>
      (window as unknown as { __shifts: Shift[] }).__shifts
        .filter((s) => s.start > after && !s.hadRecentInput)
        .reduce((total, s) => total + s.value, 0),
    since,
  );

// Hydration settles the hero (the demo's answer, the engine slot's width) on its own schedule;
// shifts from it are not the fonts', so measuring starts once the page has gone quiet.
async function settled(page: Page): Promise<number> {
  await expect(page.locator("#demo")).toContainText("Hilo Caribe");
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const shifts = (window as unknown as { __shifts: Shift[] }).__shifts;
        const watching = performance.now();
        const check = () => {
          const now = performance.now();
          if (now - Math.max(watching, shifts.at(-1)?.start ?? 0) >= 500) resolve(now);
          else setTimeout(check, 50);
        };
        requestAnimationFrame(() => requestAnimationFrame(check));
      }),
  );
}

// next/font's metric-adjusted fallbacks are font faces too (local() ones); only count web fonts.
const loadedFonts = (page: Page) =>
  page.evaluate(
    () =>
      [...document.fonts].filter((f) => f.status === "loaded" && !f.family.endsWith(" Fallback"))
        .length,
  );

test("the landing does not move when late web fonts swap in", async ({ page }) => {
  await recordShifts(page);
  // Fonts are held until the page has settled on the fallbacks, so the swap is what gets measured.
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(fonts, async (route) => {
    await released;
    await route.continue();
  });

  const navigated = Date.now();
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const before = await settled(page);
  expect(await loadedFonts(page)).toBe(0);
  await page.waitForTimeout(Math.max(0, 1500 - (Date.now() - navigated)));
  release();

  await expect.poll(() => loadedFonts(page)).toBeGreaterThan(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 500)));
  });

  expect(await clsSince(page, before)).toBeLessThanOrEqual(0.05);
});

test("the landing keeps its layout when the web fonts fail to load", async ({
  page,
  gotoStable,
}) => {
  await recordShifts(page);
  await page.route(fonts, (route) => route.abort());
  await gotoStable("/");
  const before = await settled(page);

  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    while (window.scrollY + window.innerHeight < document.documentElement.scrollHeight) {
      window.scrollBy(0, step);
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
    }
  });

  expect(await clsSince(page, before)).toBeLessThanOrEqual(0.05);
});
