import { expect, test } from "@reranker/testing/playwright";
import { publicRoutes } from "./routes.ts";

for (const route of publicRoutes) {
  test(`${route.name} has 0 axe violations (WCAG 2.2 AA) @smoke`, async ({
    gotoStable,
    makeAxeBuilder,
  }) => {
    await gotoStable(route.path);
    expect((await makeAxeBuilder().analyze()).violations).toEqual([]);
  });
}

test("keyboard: skip link first, then every interactive element shows a visible focus ring @smoke", async ({
  page,
  gotoStable,
}) => {
  test.skip(test.info().project.name !== "desktop-chromium", "keyboard path is desktop");
  await gotoStable("/");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveText("Saltar al contenido");
  await page.keyboard.press("Enter");
  await expect(page.locator("main#contenido")).toBeFocused();
  // Walk the whole tab order once: on to the end, through the wrap to the top, back to main.
  const visited: string[] = [];
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    if ((await focused.count()) === 0) continue;
    const seen = await focused.evaluate((el) => {
      if (el.hasAttribute("data-tab-seen")) return true;
      el.setAttribute("data-tab-seen", "");
      return false;
    });
    if (seen) break;
    const [html, ring] = await focused.evaluate((el) => {
      if (!(el instanceof HTMLElement)) return [el.outerHTML.slice(0, 120), false] as const;
      // Text fields draw their ring on the wrapper that also holds the submit button.
      const target = el.matches("input, select, textarea") ? (el.parentElement ?? el) : el;
      // Finish focus transitions so the styles read are the settled ones.
      const read = () => {
        for (const a of target.getAnimations()) a.finish();
        const s = getComputedStyle(target);
        return {
          outline: s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) >= 2,
          look: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} | ${s.boxShadow}`,
          shadow: s.boxShadow !== "none",
        };
      };
      const focusedStyle = read();
      // A shadow that is there without focus (cards, buttons) is not a focus indicator.
      el.blur();
      const unfocusedStyle = read();
      el.focus();
      const visible =
        (focusedStyle.outline || focusedStyle.shadow) && focusedStyle.look !== unfocusedStyle.look;
      return [el.outerHTML.slice(0, 120), visible] as const;
    });
    visited.push(html);
    expect(ring, html).toBe(true);
  }
  const total = await page
    .locator("a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1'])")
    .filter({ visible: true })
    .count();
  expect(visited.length).toBeGreaterThanOrEqual(total);
});
