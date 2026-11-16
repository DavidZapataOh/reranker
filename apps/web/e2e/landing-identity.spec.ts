import { expect, test } from "@reranker/testing/playwright";

// Pixel and markup identity of these pages is ui-migration.spec.ts's job; this guards the URLs.
for (const path of ["/", "/politica-de-datos", "/terminos", "/robots.txt", "/sitemap.xml"]) {
  test(`${path} is 200 without a redirect @smoke`, async ({ request }) => {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
  });
}

// The landing speaks to every Spanish-speaking country, so it stays in neutral Spanish.
test("html lang stays neutral Spanish @smoke", async ({ page, gotoStable }) => {
  for (const path of ["/", "/terminos", "/errores/not_found"]) {
    await gotoStable(path);
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
  }
});
