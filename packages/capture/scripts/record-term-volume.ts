/**
 * Records how many people search a list of terms in a language's main market: monthly Google
 * searches (Google Ads search volume) and AI-search volume. It decides whether a word people use
 * for a business category is common enough to accept as its synonym.
 *
 * Usage: pnpm --filter @reranker/capture record:term-volume <empty output dir> <language> <terms>
 * Terms are comma-separated. Two calls, charged to the spend ledger as `contract-test`.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { endPools } from "@reranker/db";
import { releaseSpend, reserveSpend, settleSpend } from "@reranker/jobs";
import { cost, costFromMajor, type ProviderCost } from "@reranker/schema";
import {
  AiOptimizationAiKeywordDataKeywordsSearchVolumeLiveRequestInfo,
  KeywordsDataGoogleAdsSearchVolumeLiveRequestInfo,
} from "dataforseo-client";
import { createDataForSeo } from "../src/dataforseo/client";
import { RawSink } from "../src/raw/raw-sink";

// The country each measurement language's templates were written from (Google Ads location codes).
const MARKETS = { es: 2170, en: 2840, pt: 2076, fr: 2250, de: 2276, it: 2380 } as const;
type Language = keyof typeof MARKETS;

// DataForSEO list prices (https://dataforseo.com/pricing, read 2026-11-20): Google Ads search
// volume Live US$0.09 per task, AI keyword volume US$0.01 plus US$0.0001 per keyword.
const PRICE = {
  ads: cost(90_000, "USD"),
  aiVolume: (n: number) => cost(10_000 + 100 * n, "USD"),
};
// Both endpoints take up to 1,000 keywords in one task.
const MAX_TERMS = 1000;

type Clients = ReturnType<typeof createDataForSeo>;
type Call = { file: string; estimate: ProviderCost; run: (c: Clients) => Promise<unknown> };
type Task = { status_code?: number; status_message?: string; cost?: number; result?: unknown[] };

function task(bytes: Uint8Array | null): Task | undefined {
  if (bytes === null) return undefined;
  try {
    return (JSON.parse(new TextDecoder().decode(bytes)) as { tasks?: Task[] }).tasks?.[0];
  } catch {
    return undefined;
  }
}

async function record(outDir: string, refId: string, call: Call): Promise<Task | undefined> {
  const reservation = await reserveSpend({
    provider: "dataforseo",
    purpose: "contract-test",
    refType: "term-volume",
    refId,
    estimate: call.estimate,
  });
  const sink = new RawSink();
  try {
    await call.run(createDataForSeo(sink, { base: "production" }));
  } catch (error) {
    // The official client throws on a non-200 or non-JSON body; its bytes are still recorded.
    console.error(`${call.file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (sink.response !== null) writeFileSync(join(outDir, call.file), sink.response);
  const result = task(sink.response);
  if (typeof result?.cost === "number" && result.cost > 0) {
    await settleSpend(reservation, costFromMajor(result.cost.toFixed(6), "USD"));
  } else {
    await releaseSpend(reservation);
  }
  return result;
}

type Row = { keyword?: string; search_volume?: number | null; ai_search_volume?: number | null };

async function main(outDir: string, language: Language, terms: string[]): Promise<boolean> {
  mkdirSync(outDir, { recursive: true });
  if (readdirSync(outDir).length > 0) throw new Error(`${outDir} is not empty`);
  if (terms.length === 0 || terms.length > MAX_TERMS) {
    throw new Error(`between 1 and ${MAX_TERMS} terms, got ${terms.length}`);
  }
  const target = { location_code: MARKETS[language], language_code: language };
  const refId = randomUUID();
  const [ads, ai] = await Promise.all([
    record(outDir, refId, {
      file: "google-ads.json",
      estimate: PRICE.ads,
      run: (c) =>
        c.keywords.googleAdsSearchVolumeLive([
          new KeywordsDataGoogleAdsSearchVolumeLiveRequestInfo({ keywords: terms, ...target }),
        ]),
    }),
    record(outDir, refId, {
      file: "ai-volume.json",
      estimate: PRICE.aiVolume(terms.length),
      run: (c) =>
        c.ai.aiKeywordDataKeywordsSearchVolumeLive([
          new AiOptimizationAiKeywordDataKeywordsSearchVolumeLiveRequestInfo({
            keywords: terms,
            ...target,
          }),
        ]),
    }),
  ]);
  const adsRows = (ads?.result ?? []) as Row[];
  const aiRows = ((ai?.result?.[0] as { items?: Row[] } | undefined)?.items ?? []) as Row[];
  const volume = (rows: Row[], term: string, field: "search_volume" | "ai_search_volume") =>
    rows.find((r) => r.keyword?.toLowerCase() === term.toLowerCase())?.[field] ?? null;
  const table = [
    `${language} (location ${MARKETS[language]}): Google Ads ${ads?.status_code}, AI ${ai?.status_code}`,
    "",
    "| term | Google searches a month | AI searches a month |",
    "|---|---|---|",
    ...terms.map(
      (t) =>
        `| ${t} | ${volume(adsRows, t, "search_volume") ?? ""} | ${volume(aiRows, t, "ai_search_volume") ?? ""} |`,
    ),
    "",
  ].join("\n");
  writeFileSync(join(outDir, "summary.md"), table);
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  return ads?.status_code === 20000 && ai?.status_code === 20000;
}

const [outDir, language, list] = process.argv.slice(2);
if (!outDir || !language || !list || !Object.hasOwn(MARKETS, language)) {
  throw new Error(
    "Usage: record-term-volume.ts <empty output dir> <language> <comma-separated terms>",
  );
}
const terms = [
  ...new Set(
    list
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  ),
];
try {
  process.exitCode = (await main(resolve(outDir), language as Language, terms)) ? 0 : 1;
} finally {
  await endPools();
}
