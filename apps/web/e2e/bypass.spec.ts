import { expect, test } from "@reranker/testing/playwright";

const PROBE = "https://bypass-probe.example";

test("the bypass secret only goes to the deployment's own origin @smoke", async ({
  page,
  gotoStable,
  baseURL,
}) => {
  test.skip(!process.env.VERCEL_AUTOMATION_BYPASS_SECRET, "runs where the secret is set");
  // Delivery to the deployment itself is proven by every other test: protected previews
  // answer 401 without the header.
  const origin = new URL(baseURL ?? "").origin;
  const leaked: string[] = [];
  page.on("request", async (r) => {
    if (new URL(r.url()).origin === origin) return;
    if ("x-vercel-protection-bypass" in (await r.allHeaders())) leaked.push(r.url());
  });
  // A guaranteed cross-origin request, answered locally so nothing leaves the runner.
  await page.route(`${PROBE}/**`, (route) => route.fulfill({ status: 204 }));
  await gotoStable("/");
  await page.evaluate((probe) => fetch(`${probe}/x`, { mode: "no-cors" }), PROBE);
  await page.waitForLoadState("networkidle");
  expect(leaked).toEqual([]);
});
