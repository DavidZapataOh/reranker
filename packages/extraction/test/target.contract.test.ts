import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { endPools } from "@reranker/db";
import type { SpendContext } from "@reranker/jobs";
import { requireEnv } from "@reranker/testing/env";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { findBusinessCandidates } from "../src/target";
import { shapeOf } from "./places/shape";

const spend: SpendContext = {
  purpose: "contract-test",
  refType: "target-contract",
  refId: randomUUID(),
};

// Each run rewrites the shapes of these searches, which the client unit tests parse.
const RECORDED = new URL("fixtures/recorded/sandbox/", import.meta.url);
const CITIES = {
  "Contramar Ciudad de México": "places-search-text-mexico-city",
  "Sobrino de Botín Madrid": "places-search-text-madrid",
  "Hotel Nacional de Cuba La Habana": "places-search-text-havana",
} as const;
const answers = new Map<string, unknown>();

beforeAll(() => {
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
  vi.stubEnv("GOOGLE_PLACES_API_KEY", requireEnv("GOOGLE_PLACES_API_KEY_CI"));
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const response = await realFetch(input, init);
    if (String(input).endsWith("/places:searchText") && response.ok) {
      const { textQuery } = JSON.parse(String(init?.body)) as { textQuery: string };
      answers.set(textQuery, await response.clone().json());
    }
    return response;
  });
});
afterAll(async () => {
  mkdirSync(RECORDED, { recursive: true });
  for (const [query, name] of Object.entries(CITIES)) {
    if (!answers.has(query)) continue;
    const shape = `${JSON.stringify(shapeOf(answers.get(query)), null, 2)}\n`;
    writeFileSync(new URL(`${name}.json`, RECORDED), shape);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await endPools();
});

// Three Text Search Pro requests (0.096 USD).
test("businesses in Mexico City and Madrid come with their country; one in Havana does not", async () => {
  const [mexico, madrid, havana] = await Promise.all(
    Object.keys(CITIES).map((query) => findBusinessCandidates({ query, country: null, spend })),
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
