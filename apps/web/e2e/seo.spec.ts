import { expect, test } from "@reranker/testing/playwright";
import { appTarget } from "./routes.ts";

test("robots.txt allows all, hides /ingest/ and points to the sitemap @smoke", async ({
  request,
}) => {
  const body = await (await request.get("/robots.txt")).text();
  expect(body).toContain("User-Agent: *");
  expect(body).toContain("Allow: /");
  expect(body).toContain("Disallow: /ingest/");
  expect(body).toContain("Sitemap: https://reranker.co/sitemap.xml");
});

test("sitemap lists exactly the 3 public routes @smoke", async ({ request }) => {
  const xml = await (await request.get("/sitemap.xml")).text();
  const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  expect(locs.sort()).toEqual([
    "https://reranker.co",
    "https://reranker.co/politica-de-datos",
    "https://reranker.co/terminos",
  ]);
});

test("every JSON-LD block parses and declares Organization, WebSite, SoftwareApplication and FAQPage @smoke", async ({
  page,
  gotoStable,
}) => {
  await gotoStable("/");
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  const types = blocks.flatMap((b) => {
    const json = JSON.parse(b);
    return (json["@graph"] ?? [json]).map((n: { "@type": string }) => n["@type"]);
  });
  expect(types).toEqual(
    expect.arrayContaining(["Organization", "WebSite", "SoftwareApplication", "FAQPage"]),
  );
});

test("X-Robots-Tag noindex only on previews @smoke", async ({ request, baseURL }) => {
  const tag = (await request.get("/")).headers()["x-robots-tag"];
  if (appTarget === "preview") expect(tag).toContain("noindex");
  if (baseURL && new URL(baseURL).host === "reranker.co") {
    expect(tag ?? "").not.toContain("noindex");
  }
});

test("home is in neutral Spanish and offers every currency in JSON-LD @smoke", async ({
  page,
  gotoStable,
}) => {
  await gotoStable("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute("content", "es_LA");
  const graph = (
    await Promise.all(
      (
        await page.locator('script[type="application/ld+json"]').allTextContents()
      ).map((b) => JSON.parse(b)["@graph"] ?? []),
    )
  ).flat() as { "@type": string; areaServed?: unknown; offers?: { priceCurrency: string }[] }[];
  expect(graph.some((n) => n.areaServed)).toBe(false);
  const app = graph.find((n) => n["@type"] === "SoftwareApplication");
  expect(new Set(app?.offers?.map((o) => o.priceCurrency))).toEqual(new Set(["COP", "EUR", "USD"]));
});
