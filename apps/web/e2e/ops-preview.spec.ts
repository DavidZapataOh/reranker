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

// posthog-js drops every event from a browser that reports itself as automated or headless.
async function passAsVisitor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "userAgentData", { get: () => undefined });
  });
}

// Answering the capture requests keeps test traffic out of the shared preview PostHog project.
async function recordCaptures(page: Page): Promise<CapturedEvent[]> {
  const events: CapturedEvent[] = [];
  await passAsVisitor(page);
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

test.describe("fault routes", () => {
  test("production hides them", async ({ request }) => {
    test.skip(appTarget !== "production", "only production hides the fault routes");
    expect((await request.get("/ops/fault?kind=client")).status()).toBe(404);
    expect((await request.get("/api/ops/fault?kind=handler")).status()).toBe(404);
  });

  test("a client error shows the error page with a way back", async ({ page, makeAxeBuilder }) => {
    test.skip(appTarget === "production", "production never serves the fault page");
    await page.goto("/ops/fault?kind=client");
    await expect(page.getByRole("alert")).toContainText("Algo salió mal");
    await expect(page.getByRole("alert")).toContainText("Recarga la página para seguir.");
    await expect(page.getByRole("button", { name: "Recargar" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    expect((await makeAxeBuilder().analyze()).violations).toEqual([]);
  });
});

// PostHog stores an exception within seconds to a minute of its capture; the query API reads it back.
const POSTHOG_API = "https://us.posthog.com";
const POSTHOG_PROJECT_ID = "711803";
const PII = /ana\.prueba@reranker\.co|310 555 1234/;

type Frame = { source?: string; resolved?: boolean };
type ExceptionProperties = {
  $exception_list?: { stacktrace?: { frames?: Frame[] } }[];
  // Keyed by release id; PostHog fills it from the release injected with the source maps.
  $exception_releases?: Record<string, { version?: string }> | string;
};

async function findException(
  key: string,
  message: string,
  since: number,
): Promise<ExceptionProperties | undefined> {
  const response = await fetch(`${POSTHOG_API}/api/projects/${POSTHOG_PROJECT_ID}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: {
        kind: "HogQLQuery",
        query:
          "SELECT properties FROM events WHERE event = '$exception' AND timestamp >= fromUnixTimestamp({since}) AND properties.app_env = 'preview' AND toString(properties.$exception_list) ILIKE {pattern} ORDER BY timestamp DESC LIMIT 1",
        values: { since: Math.floor(since / 1000), pattern: `%${message}%` },
      },
    }),
  });
  if (!response.ok) throw new Error(`PostHog query failed with ${response.status}`);
  const { results } = (await response.json()) as { results: [string | ExceptionProperties][] };
  const properties = results[0]?.[0];
  return typeof properties === "string" ? JSON.parse(properties) : properties;
}

function releasesOf(properties: ExceptionProperties): string[] {
  const releases = properties.$exception_releases ?? {};
  const map: Record<string, { version?: string }> =
    typeof releases === "string" ? JSON.parse(releases) : releases;
  return Object.values(map).flatMap((release) => (release.version ? [release.version] : []));
}

function framesOf(properties: ExceptionProperties): Frame[] {
  return (properties.$exception_list ?? []).flatMap((e) => e.stacktrace?.frames ?? []);
}

test.describe("error tracking", () => {
  const key = process.env.POSTHOG_QUERY_READ_KEY ?? "";
  const release = process.env.TARGET_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA;
  test.skip(appTarget !== "preview", "faults are raised on preview only");
  test.skip(
    key === "",
    "needs POSTHOG_QUERY_READ_KEY (PostHog personal API key with query:read) to read exceptions back",
  );
  test.skip(({ isMobile }) => isMobile, "one browser is enough");
  test.setTimeout(180_000);

  async function expectCaptured(message: string, since: number) {
    let found: ExceptionProperties | undefined;
    await expect
      .poll(
        async () => {
          found = await findException(key, message, since);
          return found !== undefined;
        },
        { timeout: 120_000, intervals: [5_000] },
      )
      .toBe(true);
    const properties = found ?? {};
    expect(release, "TARGET_SHA or VERCEL_GIT_COMMIT_SHA names the deployed commit").toBeTruthy();
    expect(releasesOf(properties)).toContain(release);
    // Resolved through the uploaded source maps to the original file.
    expect(framesOf(properties).some((f) => f.resolved && /\.tsx?$/.test(f.source ?? ""))).toBe(
      true,
    );
    expect(JSON.stringify(properties)).not.toMatch(PII);
  }

  test("a route handler error reaches PostHog resolved", async ({ request }) => {
    const since = Date.now();
    expect((await request.get("/api/ops/fault?kind=handler")).status()).toBe(500);
    await expectCaptured("ops fault: handler", since);
  });

  test("an error after the response reaches PostHog resolved", async ({ request }) => {
    const since = Date.now();
    expect((await request.get("/api/ops/fault?kind=after")).status()).toBe(202);
    await expectCaptured("ops fault: after", since);
  });

  test("an error carrying personal data arrives redacted", async ({ request }) => {
    const since = Date.now();
    expect((await request.get("/api/ops/fault?kind=pii")).status()).toBe(500);
    await expectCaptured("ops fault: [redacted]", since);
  });

  test("a client render error shows the error page and reaches PostHog resolved", async ({
    page,
  }) => {
    await passAsVisitor(page);
    const since = Date.now();
    await page.goto("/ops/fault?kind=client");
    await expect(page.getByRole("alert")).toContainText("Algo salió mal");
    await expect(page.getByRole("button", { name: "Recargar" })).toBeVisible();
    await expectCaptured("ops fault: client", since);
  });
});
