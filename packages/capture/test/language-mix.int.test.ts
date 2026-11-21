import { randomUUID } from "node:crypto";
import { getGeo } from "@reranker/catalog";
import { endPools, withSystem } from "@reranker/db";
import { languageMixClaims, languageMixes } from "@reranker/db/schema";
import { eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { estimateLanguageMix } from "../src/language-mix/estimate";
import { installFakeDataForSeo, provider } from "./support/language-mix";

vi.hoisted(() => {
  // Outside production every provider is capped at zero; this suite pays a fake DataForSEO.
  process.env.SPEND_CAP_DAILY_DATAFORSEO_USD = "5";
});

const MIAMI = getGeo("us-c1015116");
const TERMS = { en: ["dentist"], es: ["dentista"] };

installFakeDataForSeo();
// Each test gets a category of its own, so no row or claim of another run meets it.
let category: string;
beforeEach(() => {
  category = `test:${randomUUID()}`;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await withSystem("capture.test", (tx) =>
    tx.delete(languageMixes).where(eq(languageMixes.categoryKey, category)),
  );
});
afterAll(() => endPools());

const estimate = (deadlineMs = 10_000, terms: Record<string, string[]> = TERMS) =>
  estimateLanguageMix({
    geo: MIAMI,
    categoryKey: category,
    terms,
    scope: "local",
    deadlineAt: Date.now() + deadlineMs,
  });

const rowOf = () =>
  withSystem("capture.test", (tx) =>
    tx
      .select()
      .from(languageMixes)
      .where(eq(languageMixes.categoryKey, category))
      .then(([row]) => row ?? null),
  );

describe("estimateLanguageMix", () => {
  test("stores a Miami dentist's mix and serves it again without a call", async () => {
    provider.ads.set(1015116, {
      "dentist near me": 10_400,
      "dentista cerca de mi": 1250,
    });
    const mix = await estimate();
    expect(mix).toMatchObject({
      shares: { en: 0.8927, es: 0.1073 },
      level: "city",
      source: "google_ads",
      second: { kind: "second", language: "es", share: 0.1073 },
      degraded: null,
    });
    expect(mix.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await rowOf()).toMatchObject({
      volumes: { en: 10_400, es: 1250 },
      keywordVolumes: { "dentist near me": 10_400, "dentista cerca de mi": 1250 },
      cost_amount_micros: 90_000,
    });

    const startedAt = performance.now();
    expect(await estimate()).toEqual(mix);
    expect(performance.now() - startedAt).toBeLessThan(5);
    expect(provider.calls).toHaveLength(1);
  });

  test("concurrent callers share one fetch", async () => {
    provider.ads.set(1015116, { "dentist near me": 900, "dentista cerca de mi": 100 });
    provider.delayMs = 400;
    const mixes = await Promise.all(Array.from({ length: 8 }, () => estimate()));
    expect(provider.calls).toHaveLength(1);
    for (const mix of mixes) expect(mix.shares).toEqual({ en: 0.9, es: 0.1 });
  });

  test("past the deadline the main language comes back alone and the fetch still lands", async () => {
    provider.ads.set(1015116, { "dentist near me": 900, "dentista cerca de mi": 100 });
    provider.delayMs = 1500;
    const startedAt = performance.now();
    expect(await estimate(200)).toMatchObject({ degraded: "deadline", shares: {}, level: null });
    expect(performance.now() - startedAt).toBeLessThan(1000);
    await vi.waitFor(async () => expect(await rowOf()).not.toBeNull(), { timeout: 5000 });
    expect((await estimate()).shares).toEqual({ en: 0.9, es: 0.1 });
  });

  test("a failed fetch degrades with notice, stores nothing and frees the key", async () => {
    provider.status = 502;
    expect(await estimate()).toMatchObject({ degraded: "unavailable", second: { kind: "none" } });
    expect(await rowOf()).toBeNull();
    const claims = await withSystem("capture.test", (tx) =>
      tx
        .select()
        .from(languageMixClaims)
        .where(like(languageMixClaims.key, `${MIAMI.key}|${category}|%`)),
    );
    expect(claims).toEqual([]);
    provider.status = 200;
    provider.ads.set(1015116, { "dentist near me": 100 });
    expect(await estimate()).toMatchObject({ degraded: null, shares: { en: 1 } });
  });

  test("words in one language cost nothing", async () => {
    expect(await estimate(10_000, { en: ["dentist"] })).toMatchObject({
      shares: {},
      degraded: null,
    });
    expect(provider.calls).toEqual([]);
  });
});
