import { existsSync, readFileSync } from "node:fs";
import { ERROR_CODES } from "@reranker/schema";
import { expect, test } from "vitest";

const manifest = new URL("../.next/prerender-manifest.json", import.meta.url);

// Reads the output of `next build`; without one there is nothing to check.
test.skipIf(!existsSync(manifest))("landing and error pages stay prerendered", () => {
  const { routes } = JSON.parse(readFileSync(manifest, "utf8")) as {
    routes: Record<string, unknown>;
  };
  // The proxy serves / from the prerendered home of the visitor's currency.
  expect(Object.keys(routes)).toEqual(
    expect.arrayContaining([
      "/home/cop",
      "/home/eur",
      "/home/usd",
      "/terminos",
      "/politica-de-datos",
      "/robots.txt",
      "/sitemap.xml",
      ...ERROR_CODES.map((code) => `/errores/${code}`),
    ]),
  );
});
