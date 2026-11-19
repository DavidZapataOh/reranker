/**
 * Records real DataForSEO production answers for local-business questions so the parsers are
 * tested on what the engines actually return, not on the sandbox's canned answers.
 *
 * Usage: pnpm --filter @reranker/capture record:live <empty output dir>
 * Each file holds a response's exact wire bytes. Every call is charged to the spend ledger as
 * `contract-test`, and the run refuses to start above its budget.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { geoForEngine, getGeo } from "@reranker/catalog";
import { endPools } from "@reranker/db";
import { releaseSpend, reserveSpend, settleSpend } from "@reranker/jobs";
import { costFromMajor, type EngineId } from "@reranker/schema";
import type { GeoKey } from "@reranker/schema/measurement";
import { createDataForSeo } from "../src/dataforseo/client";
import { LIVE } from "../src/dataforseo/live";
import { buildRequest } from "../src/dataforseo/request";
import { ENGINES } from "../src/engines";
import { RawSink } from "../src/raw/raw-sink";
import { type FrozenSlot, slotId } from "../src/slot";

const MEDELLIN = "co-c1003654";
const BOGOTA = "co-c1003659";
const MEXICO_CITY = "mx-c1010043";

// File prefix per engine, the names the sandbox recordings use.
const FILE: Record<Exclude<EngineId, "perplexity">, string> = {
  chatgpt: "chatgpt",
  gemini: "gemini",
  "google-ai-overview": "ai-overview",
  "google-ai-mode": "ai-mode",
};
const ALL = Object.keys(FILE) as (keyof typeof FILE)[];

// Local-business questions in Spanish, plus navigational ones Google answers without an AI
// Overview; two of those in case one starts showing it.
const CASES: { name: string; geoKey: GeoKey; prompt: string; engines: (keyof typeof FILE)[] }[] = [
  {
    name: "dentistas-medellin",
    geoKey: MEDELLIN,
    prompt: "mejores dentistas en Medellín",
    engines: ALL,
  },
  {
    name: "colchon-bogota",
    geoKey: BOGOTA,
    prompt: "dónde comprar un colchón en Bogotá",
    engines: ALL,
  },
  {
    name: "abogado-laboral-cdmx",
    geoKey: MEXICO_CITY,
    prompt: "abogado laboral en Ciudad de México",
    engines: ALL,
  },
  {
    name: "pico-y-placa-medellin",
    geoKey: MEDELLIN,
    prompt: "pico y placa Medellín hoy",
    engines: ALL,
  },
  {
    name: "clima-medellin",
    geoKey: MEDELLIN,
    prompt: "clima en Medellín",
    engines: ["google-ai-overview"],
  },
];

// Well under a day's contract-test cap: about twenty calls at US$0.004.
const BUDGET_MICROS = 100_000;

const MEASUREMENT = "recording";

function slot(engine: EngineId, geoKey: GeoKey, prompt: string, slotIndex: number): FrozenSlot {
  const geoDeclared = geoForEngine(engine, getGeo(geoKey), "local", { provider: "dataforseo" });
  if (!geoDeclared) throw new Error(`${engine} is not offered in ${geoKey}`);
  return {
    engine,
    provider: "dataforseo",
    intentSetId: "is_0000000000000000",
    intentId: "gen:recording.local",
    paraphraseId: "p1",
    geoKey,
    geoDeclared,
    runIndex: 0,
    promptText: prompt,
    measurementId: MEASUREMENT,
    slotIndex,
    slotId: slotId(MEASUREMENT, slotIndex),
  };
}

function reported(bytes: Uint8Array): { status: unknown; cost: unknown; model: unknown } {
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    const task = body?.tasks?.[0];
    return {
      status: task?.status_code ?? body?.status_code,
      cost: task?.cost,
      model: task?.result?.[0]?.model,
    };
  } catch {
    return { status: "not JSON", cost: undefined, model: undefined };
  }
}

async function main(outDir: string): Promise<boolean> {
  mkdirSync(outDir, { recursive: true });
  if (readdirSync(outDir).length > 0) throw new Error(`${outDir} is not empty`);

  const calls = CASES.flatMap((c) => c.engines.map((engine) => ({ ...c, engine })));
  const total = calls.reduce((sum, c) => sum + ENGINES[c.engine].estimate.live.amount_micros, 0);
  if (total > BUDGET_MICROS) throw new Error(`Estimated ${total} micro-USD exceeds the budget`);

  const refId = randomUUID();
  const summary = ["| file | status | cost | model | ms |", "|---|---|---|---|---|"];
  let ok = true;
  for (const [index, call] of calls.entries()) {
    const file = `${FILE[call.engine]}-${call.name}.json`;
    const request = buildRequest(slot(call.engine, call.geoKey, call.prompt, index), "live");
    const reservation = await reserveSpend({
      provider: "dataforseo",
      channel: "ui-vendor",
      engine: call.engine,
      purpose: "contract-test",
      refType: "dataforseo-recording",
      refId,
      estimate: ENGINES[call.engine].estimate.live,
    });
    const sink = new RawSink();
    const started = performance.now();
    try {
      await LIVE[call.engine]?.(createDataForSeo(sink, { base: "production" }), request);
    } catch (error) {
      // The official client throws on a non-200 or non-JSON body; its bytes are still recorded.
      console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const ms = Math.round(performance.now() - started);
    const bytes = sink.response;
    if (bytes === null) {
      await releaseSpend(reservation);
      summary.push(`| ${file} | no response | | | ${ms} |`);
      ok = false;
      continue;
    }
    writeFileSync(join(outDir, file), bytes);
    const { status, cost, model } = reported(bytes);
    if (typeof cost === "number") {
      await settleSpend(reservation, costFromMajor(cost.toFixed(6), "USD"));
    } else {
      await releaseSpend(reservation);
    }
    if (status !== 20000) ok = false;
    summary.push(`| ${file} | ${status} | ${cost ?? ""} | ${model ?? ""} | ${ms} |`);
  }
  const table = `${summary.join("\n")}\n`;
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  return ok;
}

const outDir = process.argv[2];
if (!outDir) throw new Error("Usage: record-live.ts <empty output dir>");
try {
  process.exitCode = (await main(resolve(outDir))) ? 0 : 1;
} finally {
  await endPools();
}
