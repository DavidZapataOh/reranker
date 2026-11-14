import { gunzipSync } from "node:zlib";
import type { Page, Request } from "@playwright/test";
import { expect, test } from "@reranker/testing/playwright";
import { appTarget } from "./routes.ts";

const GA_OR_CLARITY = /googletagmanager\.com|google-analytics\.com|clarity\.ms/;
// posthog-js sends events to /e/ (or /i/v0/e/) and batches to /batch/ under the /ingest proxy.
const CAPTURE = /\/ingest\/(?:i\/v0\/)?(?:e|batch)\/?(?:\?|$)/;

type CapturedEvent = { event: string; properties: Record<string, unknown> };

// posthog-js gzips the body and sends one event, a list, or an envelope with a `batch` list.
function decodeCapture(request: Request): CapturedEvent[] {
  const body = request.postDataBuffer();
  if (!body) return [];
  const text = (body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString("utf8");
  const parsed = JSON.parse(text) as CapturedEvent | CapturedEvent[] | { batch: CapturedEvent[] };
  if (Array.isArray(parsed)) return parsed;
  return "batch" in parsed ? parsed.batch : [parsed];
}

// Answering the capture requests keeps test traffic out of the shared preview PostHog project.
async function recordCaptures(page: Page): Promise<CapturedEvent[]> {
  const events: CapturedEvent[] = [];
  // posthog-js drops every event from a browser that reports itself as automated or headless.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "userAgentData", { get: () => undefined });
  });
  await page.route(CAPTURE, async (route) => {
    events.push(...decodeCapture(route.request()));
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"status":1}' });
  });
  return events;
}

test.describe("environment separation", () => {
  test.skip(appTarget !== "preview", "environment separation is asserted on preview only");

  test("preview never loads GA or Clarity, even after consent @smoke", async ({
    page,
    gotoStable,
  }) => {
    const hits: string[] = [];
    page.on("request", (r) => {
      if (GA_OR_CLARITY.test(r.url())) hits.push(r.url());
    });
    await gotoStable("/");
    await page.getByRole("button", { name: "Aceptar" }).click();
    await page.waitForLoadState("networkidle");
    expect(hits).toEqual([]);
  });

  test("events carry app_env=preview @smoke", async ({ page, gotoStable }) => {
    const events = await recordCaptures(page);
    // An event sent before the SDK has started is dropped, so wait until it loads its config.
    const sdkStarted = page.waitForRequest(/\/ingest\/array\/[^/]+\/config\.js/);
    await gotoStable("/");
    await sdkStarted;
    await page.getByRole("button", { name: "Aceptar" }).click();
    await expect.poll(() => events.some((e) => e.event === "consent_decided")).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.properties.app_env, e.event).toBe("preview");
  });
});
