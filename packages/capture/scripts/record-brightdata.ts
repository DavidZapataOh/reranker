/**
 * Records real Bright Data Perplexity and ChatGPT answers so their parsers are tested on what the
 * scrapers actually deliver.
 *
 * Usage: pnpm --filter @reranker/capture record:brightdata <empty output dir>
 * Reads BRIGHTDATA_API_KEY_CI, and BRIGHTDATA_BILLING_API_KEY_CI for the free tier when present.
 * For each call it writes the exact request and response bytes (the snapshot download when the
 * scrape answered 202) and a manifest with status, latency and cost. Every call is charged to the
 * spend ledger as `contract-test`, and the run refuses to start above its budget.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getGeo } from "@reranker/catalog";
import { endPools } from "@reranker/db";
import { getCountry } from "@reranker/i18n/countries";
import { releaseSpend, reserveSpend, type SpendReservation, settleSpend } from "@reranker/jobs";
import { cost } from "@reranker/schema";
import type { GeoKey } from "@reranker/schema/measurement";
import { BRIGHTDATA_API, type BrightDataDataset, createBrightData } from "../src/brightdata/client";
import { scrapeOne } from "../src/brightdata/scrape";
import { classifyResponse } from "../src/brightdata/status";
import { RawSink } from "../src/raw/raw-sink";

const MEDELLIN = "co-c1003654";
const PEREIRA = "co-c1003665";
const COLOMBIA = "co";

// The scraper's fixed page per dataset, as Bright Data's docs and SDK send it.
const PAGE: Record<BrightDataDataset, string> = {
  perplexity: "https://www.perplexity.ai",
  chatgpt: "https://chatgpt.com/",
};

// Two local questions in different cities and one national, the three a report mixes.
const CASES: { name: string; geoKey: GeoKey; prompt: string }[] = [
  { name: "dentistas-medellin", geoKey: MEDELLIN, prompt: "mejores dentistas en Medellín" },
  { name: "colchon-pereira", geoKey: PEREIRA, prompt: "dónde comprar un colchón en Pereira" },
  { name: "banco-digital-colombia", geoKey: COLOMBIA, prompt: "mejor banco digital en Colombia" },
];

// One record at Bright Data's US$1.50 per thousand; failed records are not charged.
const ESTIMATE = cost(1_500, "USD");
// Under the US$0.05 a contract run may spend.
const BUDGET_MICROS = 50_000;

// The synchronous minute plus a few snapshot polls; a later snapshot is recorded as pending.
const CALL_MS = 4 * 60_000;

function buildInput(dataset: BrightDataDataset, c: (typeof CASES)[number], index: number) {
  const target = getGeo(c.geoKey);
  const country = getCountry(target.country).providers.brightdata?.country;
  if (!country) throw new Error(`Bright Data does not cover ${target.country}`);
  // ChatGPT is asked from the city's centroid, signed and to four decimals.
  const coordinate =
    dataset === "chatgpt" && target.center
      ? `${target.center.lat.toFixed(4)},${target.center.lng.toFixed(4)}`
      : null;
  return {
    url: PAGE[dataset],
    prompt: c.prompt,
    country,
    index,
    ...(coordinate === null ? {} : { geolocation: coordinate }),
  };
}

type FreeTier = { is_enabled: boolean; used_credits: number; left_credits: number };

async function freeTier(): Promise<FreeTier | null> {
  const key = process.env.BRIGHTDATA_BILLING_API_KEY_CI;
  if (!key) return null;
  const response = await fetch(`${BRIGHTDATA_API}/trials/free_tier`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  });
  // Without it every delivered record is booked at list price, which only overstates the spend.
  if (!response.ok) {
    console.error(`GET /trials/free_tier answered ${response.status}`);
    return null;
  }
  return (await response.json()) as FreeTier;
}

type Row = {
  file: string;
  dataset: BrightDataDataset;
  outcome: string;
  http: number | null;
  snapshotId: string | null;
  polls: number;
  ms: number;
  costMicros: number;
};

async function record(
  outDir: string,
  dataset: BrightDataDataset,
  c: (typeof CASES)[number],
  index: number,
  free: boolean,
  refId: string,
): Promise<Row> {
  const file = `${dataset}-${c.name}`;
  const apiKey = process.env.BRIGHTDATA_API_KEY_CI;
  if (!apiKey) throw new Error("BRIGHTDATA_API_KEY_CI missing");
  const sink = new RawSink();
  const client = createBrightData(sink, { apiKey });
  const reservation: SpendReservation = await reserveSpend({
    provider: "brightdata",
    channel: "ui-vendor",
    engine: dataset,
    purpose: "contract-test",
    refType: "brightdata-recording",
    refId,
    estimate: ESTIMATE,
  });
  const started = performance.now();
  const row: Row = {
    file,
    dataset,
    outcome: "thrown",
    http: null,
    snapshotId: null,
    polls: 0,
    ms: 0,
    costMicros: 0,
  };
  try {
    const out = await scrapeOne(client, dataset, buildInput(dataset, c, index), {
      signal: AbortSignal.timeout(CALL_MS),
      deadline: Date.now() + CALL_MS,
    });
    row.ms = Math.round(performance.now() - started);
    row.snapshotId = out.snapshotId;
    row.polls = out.polls;
    if (sink.request) writeFileSync(join(outDir, `${file}.request.json`), sink.request);
    if (out.kind === "pending") {
      // Bright Data finishes and bills the snapshot anyway.
      row.outcome = "pending";
      row.costMicros = free ? 0 : ESTIMATE.amount_micros;
    } else {
      row.http = out.http;
      writeFileSync(join(outDir, `${file}.json`), out.body);
      const classified = classifyResponse(out.http, out.body, sink.headers ?? new Headers());
      row.outcome =
        classified.kind === "error"
          ? classified.error.name
          : classified.kind === "provider_error"
            ? `provider_error:${classified.errorCode ?? ""}`
            : "ok";
      row.costMicros = classified.kind === "ok" && !free ? ESTIMATE.amount_micros : 0;
    }
  } catch (error) {
    row.ms = Math.round(performance.now() - started);
    console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    // Once a snapshot exists Bright Data may still bill it, so the reservation stands.
    if (sink.calls > 0 && sink.status === 202) row.costMicros = ESTIMATE.amount_micros;
  }
  if (row.costMicros > 0) await settleSpend(reservation, cost(row.costMicros, "USD"));
  else await releaseSpend(reservation);
  return row;
}

async function main(outDir: string): Promise<boolean> {
  mkdirSync(outDir, { recursive: true });
  if (readdirSync(outDir).length > 0) throw new Error(`${outDir} is not empty`);
  const datasets: BrightDataDataset[] = ["perplexity", "chatgpt"];
  const calls = datasets.flatMap((dataset) => CASES.map((c) => ({ dataset, c })));
  if (calls.length * ESTIMATE.amount_micros > BUDGET_MICROS) {
    throw new Error("The recording exceeds its budget");
  }

  const before = await freeTier();
  const free = before?.is_enabled === true && before.left_credits >= calls.length;
  const refId = randomUUID();
  // Each call is its own job at Bright Data, far under its limit on running jobs.
  const rows = await Promise.all(
    calls.map(({ dataset, c }, index) => record(outDir, dataset, c, index, free, refId)),
  );
  const after = await freeTier();

  writeFileSync(
    join(outDir, "manifest.json"),
    `${JSON.stringify({ recordedAt: new Date().toISOString(), freeTier: { before, after }, rows }, null, 2)}\n`,
  );
  const table = [
    "| file | outcome | http | snapshot | polls | ms | cost µUSD |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.file} | ${r.outcome} | ${r.http ?? ""} | ${r.snapshotId ?? ""} | ${r.polls} | ${r.ms} | ${r.costMicros} |`,
    ),
    "",
    `Free tier credits used: ${before?.used_credits ?? "?"} → ${after?.used_credits ?? "?"}`,
    "",
  ].join("\n");
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  return rows.every((r) => r.outcome === "ok");
}

const outDir = process.argv[2];
if (!outDir) throw new Error("Usage: record-brightdata.ts <empty output dir>");
try {
  process.exitCode = (await main(resolve(outDir))) ? 0 : 1;
} finally {
  await endPools();
}
