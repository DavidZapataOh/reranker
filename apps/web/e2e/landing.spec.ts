import { expect, test } from "@reranker/testing/playwright";

test("hero states the promise and nav links reach their sections @smoke", async ({
  page,
  gotoStable,
}) => {
  await gotoStable("/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Tus clientes le preguntan a ChatGPT, Gemini, Google y Perplexity. Que salgas tú.",
    }),
  ).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Principal" });
  for (const [label, id] of [
    ["Cómo funciona", "como-funciona"],
    ["Lo que recibes", "producto"],
    ["Precios", "precios"],
    ["Para agencias", "agencias"],
  ] as const) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
    // Below lg the links live in the collapsed menu, so they are checked even while hidden.
    await expect(
      nav.getByRole("link", { name: label, includeHidden: true }).first(),
    ).toHaveAttribute("href", `/#${id}`);
  }
});

test("consent banner appears once and remembers the choice @smoke", async ({
  page,
  gotoStable,
}) => {
  await gotoStable("/");
  const banner = page.getByRole("dialog", { name: /cookies/i });
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Rechazar" }).click();
  await page.reload();
  await expect(banner).toBeHidden();
});

test("primary CTA points to the report section @smoke", async ({ page, gotoStable }) => {
  await gotoStable("/");
  // The bar's CTA stays out of the layout on small screens until the hero field scrolls away.
  await expect(page.locator('a[href="/#reporte"]').filter({ visible: true }).first()).toBeVisible();
});

test("an unreachable deployment fails on the first goto with its URL", async ({
  gotoStable,
  baseURL,
}) => {
  await expect(gotoStable("/__definitely-missing__")).rejects.toThrow(
    `Deployment not reachable: ${baseURL}/__definitely-missing__ (404)`,
  );
});
