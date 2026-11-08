import { expect, test } from "@reranker/testing/playwright";
import { appTarget } from "./routes.ts";

const variants = [
  {
    currency: "cop",
    prices: ["COP 0", "COP 149.000", "COP 299.000"],
    agencies: "COP 249.000",
    pays: "Pagas con PSE, Nequi o tarjeta",
  },
  {
    currency: "eur",
    prices: ["€0", "€45", "€95"],
    agencies: "€179",
    pays: "Pagas con tarjeta, Apple Pay o Google Pay",
  },
  {
    currency: "usd",
    prices: ["US$0", "US$39", "US$79"],
    agencies: "US$69",
    pays: "Pagas con tarjeta, Apple Pay o Google Pay",
  },
] as const;

for (const v of variants) {
  test(`prerendered ${v.currency} home shows its prices and payment methods @smoke`, async ({
    page,
    gotoStable,
  }) => {
    await gotoStable(`/home/${v.currency}`);
    const pricing = page.locator("#precios");
    await expect(
      pricing.getByRole("heading", { name: "Precios en tu moneda, sin permanencia." }),
    ).toBeVisible();
    for (const price of v.prices)
      await expect(pricing.getByText(price, { exact: true })).toBeVisible();
    await expect(pricing).toContainText(v.pays);
    await expect(page.locator("#agencias")).toContainText(`empieza en ${v.agencies} al mes`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://reranker.co",
    );
  });
}

test("unknown currency routes are not found @smoke", async ({ request }) => {
  expect((await request.get("/home/mxn", { maxRedirects: 0 })).status()).toBe(404);
});

// Vercel overwrites x-vercel-ip-country on deployments, so the header can only be spoofed locally.
const countries = [
  ["CO", "COP 149.000"],
  ["ES", "€45"],
  ["MX", "US$39"],
  [null, "US$39"],
] as const;

for (const [country, essential] of countries) {
  test(`home served to ${country ?? "an unknown country"} prices Esencial at ${essential}`, async ({
    page,
  }) => {
    test.skip(appTarget !== "local", "the country header is set by Vercel on deployments");
    if (country) await page.setExtraHTTPHeaders({ "x-vercel-ip-country": country });
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page
        .locator("#precios article")
        .filter({ hasText: "Esencial" })
        .getByText(essential, { exact: true }),
    ).toBeVisible();
  });
}
