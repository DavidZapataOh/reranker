import { getTranslator } from "@reranker/i18n";
import { ERROR_CODES } from "@reranker/schema";
import { expect, test } from "@reranker/testing/playwright";

const t = getTranslator("es-CO", "errors");

for (const code of ERROR_CODES) {
  test(`/errores/${code} is served and accessible`, async ({ page, makeAxeBuilder }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const response = await page.goto(`/errores/${code}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(t(`${code}.title`));
    await expect(page).toHaveTitle(`${t(`${code}.title`)} · Reranker`);
    // innerText is what a person sees; textContent would also read the inline RSC payload.
    await expect(page.locator("body")).not.toContainText(code, { useInnerText: true });
    await expect(page.getByRole("link", { name: "Volver al inicio" })).toHaveAttribute("href", "/");
    expect((await makeAxeBuilder().analyze()).violations).toEqual([]);
  });
}

test("waits are spelled out from the catalog", async ({ page }) => {
  await page.goto("/errores/spend_cap_reached");
  await expect(page.getByText("Vuelve a intentarlo en 1 hora.")).toBeVisible();
});

test("an unknown code is 404", async ({ page }) => {
  const response = await page.goto("/errores/nope");
  expect(response?.status()).toBe(404);
});

test("error pages stay out of the sitemap", async ({ request }) => {
  const xml = await (await request.get("/sitemap.xml")).text();
  expect(xml).not.toContain("/errores");
});
