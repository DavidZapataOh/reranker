import { getGeo } from "@reranker/catalog";
import { endPools, withSystem } from "@reranker/db";
import { languageMixes } from "@reranker/db/schema";
import { inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { forgetLanguageMixes } from "../src/language-mix/estimate";
import { prewarmLanguageMixes, prewarmPairs } from "../src/language-mix/prewarm";
import { installFakeDataForSeo, provider } from "./support/language-mix";

vi.hoisted(() => {
  // Outside production every provider is capped at zero; this suite pays a fake DataForSEO.
  process.env.SPEND_CAP_DAILY_DATAFORSEO_USD = "5";
});

installFakeDataForSeo();
const GEOS = ["us-c1015116", "es-c1005493"];
afterEach(async () => {
  // The pairs are shared across tests, so the instance's memory goes with their rows.
  forgetLanguageMixes();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await withSystem("capture.test", (tx) =>
    tx.delete(languageMixes).where(inArray(languageMixes.geoKey, GEOS)),
  );
});
afterAll(() => endPools());

describe("prewarmPairs", () => {
  test("crosses the local seed categories with the priority cities, the national with their countries", () => {
    const pairs = prewarmPairs();
    expect(pairs).toHaveLength(5 * 8 + 4);
    expect(pairs).toContainEqual({ geo: getGeo("us-c1015116"), categoryKey: "dental_clinic" });
    expect(pairs).toContainEqual({ geo: getGeo("mx"), categoryKey: "online_store" });
  });
});

describe("prewarmLanguageMixes", () => {
  const pairs = GEOS.map((key) => ({ geo: getGeo(key), categoryKey: "dental_clinic" }));

  test("fetches each stale pair once and only reads it on the next run", async () => {
    provider.ads.set(1015116, { "dentist near me": 900, "dentista cerca de mi": 100 });
    provider.ads.set(1005493, { "dentista cerca de mi": 1700, "dentist near me": 150 });
    expect(await prewarmLanguageMixes(60_000, pairs)).toEqual({
      measured: 2,
      degraded: 0,
      left: 0,
    });
    const calls = provider.calls.length;
    forgetLanguageMixes();
    expect(await prewarmLanguageMixes(60_000, pairs)).toEqual({
      measured: 2,
      degraded: 0,
      left: 0,
    });
    expect(provider.calls).toHaveLength(calls);
  });

  test("stops at the end of its budget and leaves the rest for the next run", async () => {
    provider.ads.set(1015116, { "dentist near me": 900, "dentista cerca de mi": 100 });
    provider.delayMs = 1000;
    expect(await prewarmLanguageMixes(300, pairs)).toEqual({ measured: 0, degraded: 1, left: 1 });
  });
});
