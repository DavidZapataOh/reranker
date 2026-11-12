import type { Page } from "@playwright/test";
import { expect, test } from "@reranker/testing/playwright";
import { appTarget } from "./routes.ts";

const GA_OR_CLARITY = /googletagmanager\.com|google-analytics\.com|clarity\.ms/;

function recordRequests(page: Page, pattern: RegExp): string[] {
  const hits: string[] = [];
  page.on("request", (r) => {
    if (pattern.test(r.url())) hits.push(r.url());
  });
  return hits;
}

// Third-party tools start after window load once the browser is idle. Safari has no
// requestIdleCallback; the app falls back to a 200 ms timeout there, and so does this.
async function settleAnalytics(page: Page) {
  await page.waitForLoadState("load");
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        if (typeof window.requestIdleCallback === "function")
          window.requestIdleCallback(resolve, { timeout: 3000 });
        else setTimeout(resolve, 200);
      }),
  );
  await page.waitForLoadState("networkidle");
}

test("/ingest is rewritten to PostHog @smoke", async ({ request }) => {
  // The rewrite proxies to PostHog over the internet; offline local runs cannot reach it.
  test.skip(appTarget === "local", "checked against deployments");
  const r = await request.get("/ingest/static/array.js");
  expect(r.status()).toBe(200);
  expect(r.headers()["content-type"]).toContain("javascript");
});

test("previews never request GA or Clarity, even after consent @smoke", async ({
  page,
  gotoStable,
}) => {
  test.skip(appTarget !== "preview", "preview-only rule");
  const hits = recordRequests(page, GA_OR_CLARITY);
  await gotoStable("/");
  await page.getByRole("button", { name: "Aceptar" }).click();
  await settleAnalytics(page);
  expect(hits).toEqual([]);
});

test("Clarity and analytics cookies wait for consent @smoke", async ({ page, gotoStable }) => {
  const clarity = recordRequests(page, /clarity\.ms/);
  await gotoStable("/");
  await settleAnalytics(page);
  const cookies = (await page.context().cookies()).map((c) => c.name);
  expect(clarity).toEqual([]);
  expect(cookies.filter((name) => /^(_ga|_cl|_uet|ph_)/.test(name))).toEqual([]);
});

test("production loads Clarity once the visitor accepts @smoke", async ({ page, gotoStable }) => {
  test.skip(appTarget !== "production", "GA and Clarity only run in production");
  const clarity = recordRequests(page, /clarity\.ms/);
  await gotoStable("/");
  await settleAnalytics(page);
  await page.getByRole("button", { name: "Aceptar" }).click();
  await expect.poll(() => clarity.length).toBeGreaterThan(0);
});
