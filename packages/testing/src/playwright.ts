import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";
import { bypassHeaders } from "./bypass.ts";
import { createStepCounter, type StepCounter } from "./steps.ts";
import { assertDeploymentUrl } from "./target.ts";

export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

export type { StepCounter };

type Fixtures = {
  makeAxeBuilder: () => AxeBuilder;
  gotoStable: (path: string) => ReturnType<Page["goto"]>;
  visibleText: (page: Page) => Promise<string>;
  steps: StepCounter;
};

export const test = base.extend<Fixtures>({
  // Not `use.extraHTTPHeaders`: the browser would send those to every origin the page loads.
  context: async ({ context, baseURL }, use) => {
    const headers = bypassHeaders();
    if (baseURL && Object.keys(headers).length > 0) {
      const { origin } = new URL(baseURL);
      await context.route(
        (url) => url.origin === origin,
        (route) => route.continue({ headers: { ...route.request().headers(), ...headers } }),
      );
    }
    await use(context);
  },
  request: async ({ playwright, baseURL }, use) => {
    const request = await playwright.request.newContext({
      ...(baseURL ? { baseURL } : {}),
      extraHTTPHeaders: bypassHeaders(),
    });
    await use(request);
    await request.dispose();
  },
  makeAxeBuilder: async ({ page }, use) => {
    await use(() => new AxeBuilder({ page }).withTags([...AXE_TAGS]));
  },
  gotoStable: async ({ page, baseURL }, use) => {
    await use(async (path) => {
      const response = await page.goto(path, { waitUntil: "load" });
      if (!response?.ok()) {
        const url = response?.url() ?? new URL(path, baseURL).href;
        throw new Error(
          `Deployment not reachable: ${url} (${response?.status() ?? "no response"})`,
        );
      }
      await page.evaluate("document.fonts.ready");
      return response;
    });
  },
  // Playwright requires an object pattern as the first parameter.
  // biome-ignore lint/correctness/noEmptyPattern: fixture signature
  visibleText: async ({}, use) => {
    // biome-ignore lint/performance/useDomNodeTextContent: visible text is the point
    await use(async (page) => (await page.locator("body").innerText()).replace(/\s+/g, " ").trim());
  },
  // biome-ignore lint/correctness/noEmptyPattern: fixture signature
  steps: async ({}, use) => {
    await use(createStepCounter((label, fn) => test.step(label, fn)));
  },
});

export { assertDeploymentUrl, bypassHeaders, expect };
