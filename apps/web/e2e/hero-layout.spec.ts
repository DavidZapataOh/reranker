import type { Page } from "@playwright/test";
import { expect, test } from "@reranker/testing/playwright";
import { recordShifts, shiftsSince } from "./layout-shifts";

// The hero hydrates and then animates on its own (engine roll, demo typing); none of it may
// move content. Motion stays on: reduced motion would skip exactly what is under test.
test.use({ reducedMotion: "no-preference" });

// A fast local server hydrates before first paint, which hides hydration shifts. Holding the
// scripts back paints the server HTML first, as a phone on a real network does.
const SCRIPT_DELAY_MS = 1_000;

// The rotator holds each engine 2.2 s and rolls in 0.52 s; this covers the first roll.
const ROLL_SETTLED_MS = SCRIPT_DELAY_MS + 3_500;

async function holdScripts(page: Page) {
  await page.route(
    (url) => url.pathname.startsWith("/_next/static/") && url.pathname.endsWith(".js"),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, SCRIPT_DELAY_MS));
      // fallback, not continue: the fixture's context route adds the deployment bypass headers.
      await route.fallback();
    },
  );
}

// Waits out the demo typing and the first engine roll, then sums every shift since navigation.
async function heroShifts(page: Page) {
  // The screen-reader copy holds the full answer from the start; innerText skips hidden sizers.
  const typed = page
    .locator('#demo p:has(> .sr-only) > span[aria-hidden="true"]')
    .filter({ visible: true });
  await expect(typed).toHaveText(/todo el país\.\s*$/, { timeout: 15_000, useInnerText: true });
  await page.waitForFunction((ms: number) => performance.now() > ms, ROLL_SETTLED_MS, {
    timeout: 15_000,
  });
  // Let the last frame's shifts reach the observer.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 300))),
  );
  const shifts = await shiftsSince(page, 0);
  test.info().annotations.push({ type: "shifts", description: JSON.stringify(shifts) });
  const sum = (list: typeof shifts) => list.reduce((total, s) => total + s.value, 0);
  return { hero: sum(shifts.filter((s) => s.inHero)), page: sum(shifts) };
}

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "the Layout Instability API is Chromium-only",
);

test.beforeEach(async ({ page }) => {
  await recordShifts(page);
  await holdScripts(page);
});

test("the hero keeps its layout through hydration, the engine roll and the demo typing", async ({
  page,
  gotoStable,
}) => {
  await gotoStable("/");
  const cls = await heroShifts(page);
  expect.soft(cls.hero, "hero CLS").toBeLessThanOrEqual(0.02);
  expect(cls.page, "page CLS").toBeLessThanOrEqual(0.05);
});

test("the demo answer types in without moving what is around it", async ({ page, isMobile }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // In view before hydration, so the whole typing happens on screen.
  await page.locator("#demo").evaluate((demo) => demo.scrollIntoView({ block: "center" }));
  const bubble = page.locator("#demo p:has(> .sr-only)").filter({ visible: true });
  // Styled, and still empty: typing starts 0.7 s after hydration.
  await page.waitForLoadState("load");
  const empty = await bubble.evaluate((el) => el.getBoundingClientRect().height);
  const cls = await heroShifts(page);
  expect.soft(cls.hero, "hero CLS").toBeLessThanOrEqual(0.02);
  expect(cls.page, "page CLS").toBeLessThanOrEqual(0.05);
  // On phones the bubble sits in the flow, so any growth pushes the rest of the demo down.
  // On desktop it is positioned over the stage and grows with the text by design.
  if (isMobile) {
    expect(await bubble.evaluate((el) => el.getBoundingClientRect().height)).toBe(empty);
  }
});
