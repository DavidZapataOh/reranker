import { expect, test } from "vitest";
import { GET } from "./route";

test("the test store is a noindex page in Colombian Spanish that claims nothing", async () => {
  const response = GET();
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  const html = await response.text();
  expect(html).toMatch(/<html lang="es-CO">/);
  expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  expect(html).toContain("No es un negocio real");
});
