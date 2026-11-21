/**
 * Records what a missed search language mix costs and how long it takes against production
 * DataForSEO, and how long the next report waits for it from the database and from memory.
 *
 * Usage: pnpm --filter @reranker/capture record:language-mix <empty output dir> <pairs>
 * Pairs are comma-separated `geoKey:seedCategory` ("us-c1015116:dental_clinic"). Every call is
 * charged to the spend ledger as `language-mix`.
 */
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { categoryTerms, getGeo, seedCategories } from "@reranker/catalog";
import { endPools, withSystem } from "@reranker/db";
import { languageMixes } from "@reranker/db/schema";
import { and, eq } from "drizzle-orm";
import { estimateLanguageMix, forgetLanguageMixes } from "../src/language-mix/estimate";

// Long enough for the three Google Ads levels and the AI fallback: this run measures the miss.
const DEADLINE_MS = 120_000;

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const startedAt = performance.now();
  const value = await fn();
  return [value, Math.round((performance.now() - startedAt) * 10) / 10];
}

async function record(pair: string) {
  const [geoKey = "", categoryKey = ""] = pair.split(":");
  const category = seedCategories().find((c) => c.key === categoryKey);
  if (!category) throw new Error(`${categoryKey} is not a seed category`);
  const input = () => ({
    geo: getGeo(geoKey),
    categoryKey,
    terms: categoryTerms(category),
    deadlineAt: Date.now() + DEADLINE_MS,
  });
  const [mix, missMs] = await timed(() => estimateLanguageMix(input(), { base: "production" }));
  const [, memoryMs] = await timed(() => estimateLanguageMix(input()));
  forgetLanguageMixes();
  const [, databaseMs] = await timed(() => estimateLanguageMix(input()));
  const row = await withSystem("capture.record", (tx) =>
    tx
      .select()
      .from(languageMixes)
      .where(and(eq(languageMixes.geoKey, geoKey), eq(languageMixes.categoryKey, categoryKey)))
      .then(([r]) => r ?? null),
  );
  return { pair, mix, row, missMs, databaseMs, memoryMs };
}

async function main(outDir: string, pairs: string[]): Promise<boolean> {
  mkdirSync(outDir, { recursive: true });
  if (readdirSync(outDir).length > 0) throw new Error(`${outDir} is not empty`);
  const results = [];
  // One at a time, so each miss is timed alone under the 12-a-minute Google Ads Live limit.
  for (const pair of pairs) results.push(await record(pair));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  const usd = (micros: number) => (micros / 1_000_000).toFixed(4);
  const table = [
    "| place:category | level | source | shares | second | cost US$ | miss ms | database hit ms | memory hit ms |",
    "|---|---|---|---|---|---|---|---|---|",
    ...results.map(({ pair, mix, row, missMs, databaseMs, memoryMs }) =>
      [
        pair,
        mix.level ?? mix.degraded,
        mix.source ?? "",
        JSON.stringify(mix.shares),
        mix.second.kind === "second" ? `${mix.second.language} ${mix.second.share}` : "none",
        row ? usd(row.cost_amount_micros) : "",
        missMs,
        databaseMs,
        memoryMs,
      ].join(" | "),
    ),
    "",
  ]
    .map((line) => (line.startsWith("|") || line === "" ? line : `| ${line} |`))
    .join("\n");
  const spent = results.reduce((sum, r) => sum + (r.row?.cost_amount_micros ?? 0), 0);
  const summary = `${table}\nTotal US$${usd(spent)}, US$${usd(spent / results.length)} a miss.\n`;
  writeFileSync(join(outDir, "summary.md"), summary);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  return results.every((r) => r.mix.degraded === null && r.row !== null);
}

const [outDir, list] = process.argv.slice(2);
if (!outDir || !list) {
  throw new Error("Usage: record-language-mix.ts <empty output dir> <geoKey:category,...>");
}
const pairs = [
  ...new Set(
    list
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  ),
];
try {
  process.exitCode = (await main(resolve(outDir), pairs)) ? 0 : 1;
} finally {
  await endPools();
}
