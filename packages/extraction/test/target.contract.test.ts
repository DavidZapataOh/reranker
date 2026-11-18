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
  anchor: string;
  placeId?: string;
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

// Forty Text Search Pro requests (1.28 USD): each business by its bare name, with and without the
// region code. GitHub runners, like production, sit in the United States, so without a region
// code Places biases by a US address.
test("searching without a region code finds the business as often as with it", async () => {
  const found = { withRegion: 0, withoutRegion: 0 };
  const rows: string[] = [];
  for (const c of BIAS_CASES) {
    const expected =
      c.placeId ??
      (
        await searchText(
          { textQuery: c.anchor, mask: "target", regionCode: c.country.toLowerCase() },
          spend,
        )
      )[0]?.id;
    const [withRegion, withoutRegion] = await Promise.all([
      searchText(
        { textQuery: c.query, mask: "target", regionCode: c.country.toLowerCase() },
        spend,
      ),
      searchText({ textQuery: c.query, mask: "target" }, spend),
    ]);
    const inWith = withRegion.some((hit) => hit.id === expected);
    const inWithout = withoutRegion.some((hit) => hit.id === expected);
    found.withRegion += Number(inWith);
    found.withoutRegion += Number(inWithout);
    rows.push(JSON.stringify({ ...c, placeId: expected, inWith, inWithout }));
  }
  console.log(`places-country-bias\n${rows.join("\n")}\n${JSON.stringify(found)}`);
  // One business in twenty is 5 percentage points.
  expect(found.withoutRegion).toBeGreaterThanOrEqual(found.withRegion);
}, 180_000);
