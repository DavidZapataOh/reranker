import { expect, test } from "@reranker/testing/playwright";
import { appTarget } from "./routes.ts";

test("/ingest is rewritten to PostHog @smoke", async ({ request }) => {
  const r = await request.get("/ingest/static/array.js");
  expect(r.status()).toBe(200);
  expect(r.headers()["content-type"]).toContain("javascript");
});

test("previews never request GA or Clarity, even after consent @smoke", async ({
  page,
  gotoStable,
}) => {
  test.skip(appTarget !== "preview", "preview-only rule");
  const hits: string[] = [];
  page.on("request", (r) => {
    if (/googletagmanager\.com|google-analytics\.com|clarity\.ms/.test(r.url())) hits.push(r.url());
  });
  await gotoStable("/");
  await page.getByRole("button", { name: "Aceptar" }).click();
  await page.waitForLoadState("networkidle");
  expect(hits).toEqual([]);
});
