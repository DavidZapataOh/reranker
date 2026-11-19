import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { endPools } from "@reranker/db";
import type { SpendContext } from "@reranker/jobs";
import { requireEnv } from "@reranker/testing/env";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { searchText } from "../src/places/client";
import { findBusinessCandidates } from "../src/target";

vi.mock("server-only", () => ({}));

interface BiasCase {
  country: string;
  query: string;
  /** Name and full address: its top hit is the business, whatever id Google gives it today. */
  anchor: string;
}

const spend: SpendContext = {
  purpose: "contract-test",
  refType: "target-contract",
  refId: randomUUID(),
};
const BIAS_CASES: BiasCase[] = JSON.parse(
  readFileSync(new URL("fixtures/places-country-bias.json", import.meta.url), "utf8"),
);

beforeAll(() => {
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
  vi.stubEnv("GOOGLE_PLACES_API_KEY", requireEnv("GOOGLE_PLACES_API_KEY_CI"));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await endPools();
});

// Three Text Search Pro requests (0.096 USD).
test("businesses in Mexico City and Madrid come with their country; one in Havana does not", async () => {
  const [mexico, madrid, havana] = await Promise.all(
    [
      "Contramar Ciudad de México",
      "Sobrino de Botín Madrid",
      "Hotel Nacional de Cuba La Habana",
    ].map((query) => findBusinessCandidates({ query, country: null, spend })),
  );
  expect(mexico?.[0]).toMatchObject({ kind: "place", attribution: "Google Maps" });
  expect(mexico?.[0]?.geo?.country).toBe("MX");
  expect(madrid?.[0]?.geo?.country).toBe("ES");
  expect(havana?.some((c) => /\bCuba\b/.test(c.formattedAddress ?? ""))).toBe(false);
}, 30_000);

// One Text Search Pro request and one page fetch.
test("the test domain of the web project is a website candidate in Colombia", async () => {
  const candidates = await findBusinessCandidates({
    query: "tienda-ejemplo.reranker.co",
    country: null,
    spend,
  });
  expect(candidates[0]).toMatchObject({
    kind: "website",
    domain: "tienda-ejemplo.reranker.co",
    geo: { level: "country", country: "CO" },
  });
}, 30_000);

// Sixty Text Search Pro requests (1.92 USD): each business by its bare name, with and without its
// country's region code. GitHub runners, like production, sit in the United States, so without a
// region code Places biases by a US address. The search omits the region code when the request
// brings no measurable country; that holds only while doing so costs under 5 points of top-5 hits.
test("searching without a region code finds the business about as often as with it", async () => {
  const found = { withRegion: 0, withoutRegion: 0 };
  for (const c of BIAS_CASES) {
    const regionCode = c.country.toLowerCase();
    const [anchor, withRegion, withoutRegion] = await Promise.all([
      searchText({ textQuery: c.anchor, mask: "target", regionCode }, spend),
      searchText({ textQuery: c.query, mask: "target", regionCode }, spend),
      searchText({ textQuery: c.query, mask: "target" }, spend),
    ]);
    const expected = anchor[0]?.id;
    expect(expected, c.anchor).toBeDefined();
    const inWith = withRegion.some((hit) => hit.id === expected);
    const inWithout = withoutRegion.some((hit) => hit.id === expected);
    found.withRegion += Number(inWith);
    found.withoutRegion += Number(inWithout);
    console.log(JSON.stringify({ query: c.query, country: c.country, inWith, inWithout }));
  }
  const rate = (hits: number) => hits / BIAS_CASES.length;
  console.log(
    `places-country-bias with=${rate(found.withRegion)} without=${rate(found.withoutRegion)}`,
  );
  expect(rate(found.withRegion) - rate(found.withoutRegion)).toBeLessThan(0.05);
}, 180_000);
