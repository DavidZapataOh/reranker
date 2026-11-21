import { randomUUID } from "node:crypto";
import { getGeo } from "@reranker/catalog";
import { endPools, withSystem } from "@reranker/db";
import { spendLedger } from "@reranker/db/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fetchLanguageVolumes, LanguageVolumesError } from "../src/language-mix/fetch";
import { ADS, AI, installFakeDataForSeo, provider } from "./support/language-mix";

vi.hoisted(() => {
  // Outside production every provider is capped at zero; this suite pays a fake DataForSEO.
  process.env.SPEND_CAP_DAILY_DATAFORSEO_USD = "5";
});

const MIAMI = getGeo("us-c1015116");
const TERMS = { en: ["dentist"], es: ["dentista"] };

installFakeDataForSeo();
let refId: string;
beforeEach(() => {
  refId = randomUUID();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(() => endPools());

const fetch = () => fetchLanguageVolumes(MIAMI, TERMS, { refId });

const ledger = () =>
  withSystem("capture.test", (tx) =>
    tx
      .select({
        status: spendLedger.status,
        purpose: spendLedger.purpose,
        micros: spendLedger.actual_amount_micros,
      })
      .from(spendLedger)
      .where(and(eq(spendLedger.refType, "language-mix"), eq(spendLedger.refId, refId))),
  );

describe("fetchLanguageVolumes", () => {
  test("counts a Miami dentist's searches per language in the city, in one charged call", async () => {
    provider.ads.set(1015116, {
      "dentist near me": 9900,
      "dentist miami": 500,
      "dentista cerca de mi": 880,
      "dentista miami": 370,
    });
    expect(await fetch()).toEqual({
      level: "city",
      locationCode: 1015116,
      source: "google_ads",
      volumes: { en: 10_400, es: 1250 },
      costMicros: 90_000,
    });
    expect(provider.calls).toEqual([{ path: ADS, location: 1015116 }]);
    expect(await ledger()).toEqual([
      { status: "settled", purpose: "language-mix", micros: 90_000 },
    ]);
  });

  test("a city with too few searches falls back to its region", async () => {
    provider.ads.set(1015116, { "dentist near me": 40 });
    provider.ads.set(21142, { "dentist near me": 2000, "dentista cerca de mi": 500 });
    expect(await fetch()).toMatchObject({
      level: "region",
      locationCode: 21142,
      volumes: { en: 2000, es: 500 },
      costMicros: 180_000,
    });
  });

  test("without Google searches anywhere, AI-search volume stands in for the country", async () => {
    provider.ai.set("es", { "dentista cerca de mi": 30 });
    provider.ai.set("en", { "dentist near me": 70 });
    expect(await fetch()).toMatchObject({
      level: "country",
      locationCode: 2840,
      source: "ai_search",
      volumes: { en: 70, es: 30 },
    });
    expect(provider.calls.filter((c) => c.path === ADS).map((c) => c.location)).toEqual([
      1015116, 21142, 2840,
    ]);
    expect(
      provider.calls
        .filter((c) => c.path === AI)
        .map((c) => c.language)
        .sort(),
    ).toEqual(["en", "es"]);
  });

  test("no searches at all is an answer, not a failure", async () => {
    expect(await fetch()).toMatchObject({ level: "country", source: null, volumes: {} });
  });

  test("a failed call throws and keeps its reservation, as it may have been billed", async () => {
    provider.status = 502;
    await expect(fetch()).rejects.toBeInstanceOf(LanguageVolumesError);
    expect(await ledger()).toEqual([
      { status: "settled", purpose: "language-mix", micros: 90_000 },
    ]);
  });

  test("an error status from Google Ads throws", async () => {
    provider.taskStatus = 40501;
    await expect(fetch()).rejects.toBeInstanceOf(LanguageVolumesError);
  });
});
