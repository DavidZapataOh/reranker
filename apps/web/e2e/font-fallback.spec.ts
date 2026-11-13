import { expect, test } from "@reranker/testing/playwright";

// When the web fonts never arrive the page must still hold its layout: next/font's metric-adjusted
// fallbacks are what keep the swap from moving content.

// The hero demo types its answer on a timer and grows while it does; settling it first keeps
// this measuring fonts instead of when the scroll happens to overlap the typing.
test.use({ reducedMotion: "reduce" });

test("the landing keeps its layout when the web fonts fail to load", async ({
  page,
  gotoStable,
}) => {
  await page.route("**/_next/static/media/**", (route) => route.abort());
  await gotoStable("/");
  await expect(page.locator("#demo")).toContainText("Hilo Caribe");

  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    while (window.scrollY + window.innerHeight < document.documentElement.scrollHeight) {
      window.scrollBy(0, step);
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
    }
  });

  const cls = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let total = 0;
        new PerformanceObserver((list) => {
          type LayoutShift = PerformanceEntry & { value: number; hadRecentInput: boolean };
          for (const entry of list.getEntries() as LayoutShift[]) {
            if (!entry.hadRecentInput) total += entry.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
        // Buffered entries are delivered in the observer's first task.
        setTimeout(() => resolve(total), 100);
      }),
  );
  expect(cls).toBeLessThanOrEqual(0.05);
});
