import { randomUUID } from "node:crypto";
import { endPools } from "@reranker/db";
import type { SpendContext } from "@reranker/jobs";
import { requireEnv } from "@reranker/testing/env";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { placeDetails, searchText } from "../../src/places/client";

const spend: SpendContext = {
  purpose: "contract-test",
  refType: "places-contract",
  refId: randomUUID(),
};

beforeAll(() => {
  // The env helpers read APP_ENV, which the contract job does not set.
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
  vi.stubEnv("GOOGLE_PLACES_API_KEY", requireEnv("GOOGLE_PLACES_API_KEY_CI"));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await endPools();
});

// One Text Search Pro request (0.032 USD) and one free IDs Only detail per run.
test("a fixed search finds a place whose IDs Only detail returns the same id", async () => {
  const hits = await searchText(
    { textQuery: "Museo del Oro Bogotá", mask: "resolve", languageCode: "es", regionCode: "co" },
    spend,
  );
  expect(hits.length).toBeGreaterThanOrEqual(1);
  const [first] = hits;
  expect(first?.id).toMatch(/^\S+$/);
  expect(first?.displayName).not.toBe("");

  const details = await placeDetails(first?.id ?? "", "idsOnly", spend);
  expect(details?.id).toBe(first?.id);
}, 30_000);
