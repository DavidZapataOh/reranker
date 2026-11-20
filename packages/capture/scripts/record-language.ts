/**
 * Records whether ChatGPT and Gemini recommend different local businesses when the same question
 * is asked in another language from the same place, and how a city's searches split by language.
 *
 * Every question is asked in English and Spanish, three times each, so the gap between languages
 * can be compared with the run-to-run gap inside one language (see analyze-language.ts).
 *
 * Usage: pnpm --filter @reranker/capture record:language <empty output dir>
 * Each file holds a response's exact wire bytes. Every call is charged to the spend ledger as
 * `contract-test`, and the run refuses to start above its budget.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { geoForEngine, getGeo } from "@reranker/catalog";
import { endPools } from "@reranker/db";
import { releaseSpend, reserveSpend, settleSpend } from "@reranker/jobs";
import { cost, costFromMajor, type ProviderCost } from "@reranker/schema";
import type { GeoKey } from "@reranker/schema/measurement";
import {
  AiOptimizationAiKeywordDataKeywordsSearchVolumeLiveRequestInfo,
  KeywordsDataGoogleAdsSearchVolumeLiveRequestInfo,
} from "dataforseo-client";
import { createDataForSeo } from "../src/dataforseo/client";
import { LIVE } from "../src/dataforseo/live";
import { buildRequest } from "../src/dataforseo/request";
import { ENGINES } from "../src/engines";
import { RawSink } from "../src/raw/raw-sink";
import { type FrozenSlot, slotId } from "../src/slot";

type Lang = "en" | "es";
type City = "miami" | "madrid";
type Engine = "chatgpt" | "gemini";

// Google Ads criteria ids: Miami, Florida and Madrid, as the geo catalog keys them. The catalog
// has no centroid for either city yet, which would ask Gemini from the whole country, so the
// city halls stand in for it.
const CITIES: Record<
  City,
  { geoKey: GeoKey; name: string; country: number; adsCity: number; center: string }
> = {
  miami: {
    geoKey: "us-c1015116",
    name: "Miami",
    country: 2840,
    adsCity: 1015116,
    center: "25.7277800,-80.2341700",
  },
  madrid: {
    geoKey: "es-c1005493",
    name: "Madrid",
    country: 2724,
    adsCity: 1005493,
    center: "40.4189300,-3.6917400",
  },
};

// The widest radius DataForSEO accepts, the one production asks Gemini from.
const GEMINI_RADIUS_MM = 199_999;

// Two intents per category: a broad "best" question and a concrete need.
const QUESTIONS: Record<string, Record<Lang, (city: City) => string>> = {
  "dentist-best": {
    en: (c) => `What are the best dentists in ${CITIES[c].name}?`,
    es: (c) => `¿Cuáles son los mejores dentistas en ${CITIES[c].name}?`,
  },
  "dentist-need": {
    en: (c) =>
      `I need an emergency dentist in ${CITIES[c].name} today. Which one do you recommend?`,
    es: (c) => `Necesito un dentista de urgencia hoy en ${CITIES[c].name}. ¿Cuál me recomiendas?`,
  },
  "restaurant-best": {
    en: (c) => `What are the best restaurants in ${CITIES[c].name}?`,
    es: (c) => `¿Cuáles son los mejores restaurantes en ${CITIES[c].name}?`,
  },
  "restaurant-need": {
    en: (c) => `Recommend a restaurant in ${CITIES[c].name} for a family dinner.`,
    es: (c) => `Recomiéndame un restaurante en ${CITIES[c].name} para una cena familiar.`,
  },
  "lawyer-best": {
    en: (c) => `What are the best lawyers in ${CITIES[c].name}?`,
    es: (c) => `¿Cuáles son los mejores abogados en ${CITIES[c].name}?`,
  },
  "lawyer-need": {
    en: (c) => `I need a car accident lawyer in ${CITIES[c].name}. Who do you recommend?`,
    es: (c) =>
      c === "madrid"
        ? "Necesito un abogado de accidentes de tráfico en Madrid. ¿A quién me recomiendas?"
        : `Necesito un abogado de accidentes de tránsito en ${CITIES[c].name}. ¿A quién me recomiendas?`,
  },
};

const LANGS: Lang[] = ["en", "es"];
const ENGINE_IDS: Engine[] = ["chatgpt", "gemini"];
const REPEATS = 3;

// How people search each category, in both languages; "near me" carries the searches that leave
// the city out because Google already knows it.
function keywords(city: City): string[] {
  const c = CITIES[city].name.toLowerCase();
  return [
    `dentist ${c}`,
    `dentist in ${c}`,
    `best dentist in ${c}`,
    `emergency dentist ${c}`,
    "dentist near me",
    `dentista ${c}`,
    `dentista en ${c}`,
    `mejor dentista en ${c}`,
    `dentista de urgencia ${c}`,
    "dentista cerca de mi",
    `restaurants ${c}`,
    `restaurants in ${c}`,
    `best restaurants in ${c}`,
    "restaurants near me",
    `restaurantes ${c}`,
    `restaurantes en ${c}`,
    `mejores restaurantes en ${c}`,
    "restaurantes cerca de mi",
    `lawyer ${c}`,
    `attorney ${c}`,
    `car accident lawyer ${c}`,
    "lawyer near me",
    `abogado ${c}`,
    `abogados en ${c}`,
    `abogado de accidentes ${c}`,
    "abogado cerca de mi",
  ];
}

// DataForSEO list prices (https://dataforseo.com/pricing, read 2026-11-20): Google Ads search
// volume Live US$0.09 per task, AI keyword volume US$0.01 plus US$0.0001 per keyword. Location and
// language lists are free; the ledger only takes a positive reservation, released when unbilled.
const PRICE = {
  ads: cost(90_000, "USD"),
  aiVolume: (n: number) => cost(10_000 + 100 * n, "USD"),
  list: cost(1, "USD"),
};

// A hard ceiling for the whole run; the ledger's contract-test cap is the second one.
const BUDGET_MICROS = 1_400_000;
const CONCURRENCY = 6;
const MEASUREMENT = "language";

type Clients = ReturnType<typeof createDataForSeo>;
type Call = {
  file: string;
  estimate: ProviderCost;
  engine?: Engine;
  // Probes may fail by design: an unsupported location and language pair is itself the answer.
  probe?: boolean;
  run: (c: Clients) => Promise<unknown>;
};

function slot(
  engine: Engine,
  city: City,
  lang: Lang,
  prompt: string,
  slotIndex: number,
): FrozenSlot {
  const { geoKey } = CITIES[city];
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
    language: lang,
    measurementId: MEASUREMENT,
    slotIndex,
    slotId: slotId(MEASUREMENT, slotIndex),
  };
}

function answerCalls(): Call[] {
  const calls: Call[] = [];
  let index = 0;
  // Repeats outermost, so both languages of a question run close together in time.
  for (let run = 1; run <= REPEATS; run++) {
    for (const city of Object.keys(CITIES) as City[]) {
      for (const [question, text] of Object.entries(QUESTIONS)) {
        for (const lang of LANGS) {
          for (const engine of ENGINE_IDS) {
            // The production request, asked in either language from the same place.
            const request = buildRequest(
              slot(engine, city, lang, text[lang](city), index++),
              "live",
            );
            if (engine === "gemini" && "location_coordinate" in request) {
              request.location_code = undefined;
              request.location_coordinate = `${CITIES[city].center},${GEMINI_RADIUS_MM}`;
            }
            calls.push({
              file: `answers/${engine}/${city}-${question}-${lang}-r${run}.json`,
              estimate: ENGINES[engine].estimate.live,
              engine,
              run: (c) => {
                const live = LIVE[engine];
                if (!live) throw new Error(`no Live call for ${engine}`);
                return live(c, request);
              },
            });
          }
        }
      }
    }
  }
  return calls;
}

function volumeCalls(): Call[] {
  const calls: Call[] = [];
  // Without a language Google Ads counts every search in the city; with one, only the searches
  // it attributes to that language.
  const ads: [City, Lang | null][] = [
    ["miami", null],
    ["miami", "en"],
    ["miami", "es"],
    ["madrid", null],
  ];
  for (const [city, lang] of ads) {
    calls.push({
      file: `volume/google-ads-${city}-${lang ?? "all"}.json`,
      estimate: PRICE.ads,
      run: (c) =>
        c.keywords.googleAdsSearchVolumeLive([
          new KeywordsDataGoogleAdsSearchVolumeLiveRequestInfo({
            keywords: keywords(city),
            location_code: CITIES[city].adsCity,
            ...(lang ? { language_code: lang } : {}),
          }),
        ]),
    });
  }
  // AI keyword volume is national; both languages in both countries.
  for (const city of Object.keys(CITIES) as City[]) {
    for (const lang of LANGS) {
      const list = keywords(city);
      calls.push({
        file: `volume/ai-${city}-${lang}.json`,
        estimate: PRICE.aiVolume(list.length),
        probe: true,
        run: (c) =>
          c.ai.aiKeywordDataKeywordsSearchVolumeLive([
            new AiOptimizationAiKeywordDataKeywordsSearchVolumeLiveRequestInfo({
              keywords: list,
              location_code: CITIES[city].country,
              language_code: lang,
            }),
          ]),
      });
    }
  }
  // Which location and language pairs each source supports.
  const lists: [string, (c: Clients) => Promise<unknown>][] = [
    ["chatgpt-locations", (c) => c.ai.chatGptLlmScraperLocations()],
    ["chatgpt-languages", (c) => c.ai.chatGptLlmScraperLanguages()],
    ["ai-keyword-locations-languages", (c) => c.ai.aiKeywordDataLocationsAndLanguages()],
    ["labs-locations-languages", (c) => c.labs.locationsAndLanguages()],
    ["google-ads-languages", (c) => c.keywords.googleAdsLanguages()],
  ];
  for (const [name, run] of lists) {
    calls.push({ file: `support/${name}.json`, estimate: PRICE.list, probe: true, run });
  }
  return calls;
}

type Envelope = {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: { status_code?: number; status_message?: string; cost?: number }[];
};

function envelope(bytes: Uint8Array | null): Envelope | null {
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Envelope;
  } catch {
    return null;
  }
}

type Outcome = { status: unknown; message: unknown; cost: number | null; ms: number };

async function record(outDir: string, refId: string, call: Call): Promise<Outcome> {
  const reservation = await reserveSpend({
    provider: "dataforseo",
    ...(call.engine ? { channel: "ui-vendor", engine: call.engine } : {}),
    purpose: "contract-test",
    refType: "language-experiment",
    refId,
    estimate: call.estimate,
  });
  const sink = new RawSink();
  const started = performance.now();
  try {
    await call.run(createDataForSeo(sink, { base: "production" }));
  } catch (error) {
    // The official client throws on a non-200 or non-JSON body; its bytes are still recorded.
    console.error(`${call.file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const ms = Math.round(performance.now() - started);
  const bytes = sink.response;
  if (bytes !== null) writeFileSync(join(outDir, call.file), bytes);
  const body = envelope(bytes);
  const task = body?.tasks?.[0];
  const reported = task?.cost ?? body?.cost;
  if (typeof reported === "number" && reported > 0) {
    await settleSpend(reservation, costFromMajor(reported.toFixed(6), "USD"));
  } else {
    await releaseSpend(reservation);
  }
  return {
    status: task?.status_code ?? body?.status_code ?? "no response",
    message: task?.status_message ?? body?.status_message ?? "",
    cost: typeof reported === "number" ? reported : null,
    ms,
  };
}

async function main(outDir: string): Promise<boolean> {
  mkdirSync(outDir, { recursive: true });
  if (readdirSync(outDir).length > 0) throw new Error(`${outDir} is not empty`);
  for (const dir of ["answers/chatgpt", "answers/gemini", "volume", "support"]) {
    mkdirSync(join(outDir, dir), { recursive: true });
  }

  const calls = [...volumeCalls(), ...answerCalls()];
  const estimate = calls.reduce((t, c) => t + c.estimate.amount_micros, 0);
  if (estimate > BUDGET_MICROS) {
    throw new Error(`Estimated ${estimate} micro-USD exceeds the budget`);
  }

  const refId = randomUUID();
  const rows: string[] = [];
  let spent = 0;
  let failures = 0;
  const queue = [...calls];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let call = queue.shift(); call; call = queue.shift()) {
        const o = await record(outDir, refId, call);
        spent += o.cost ?? 0;
        if (o.status !== 20000 && !call.probe) failures += 1;
        rows.push(
          `| ${call.file} | ${o.status} | ${o.status === 20000 ? "" : o.message} | ${o.cost ?? ""} | ${o.ms} |`,
        );
      }
    }),
  );

  const table = [
    `Spent US$${spent.toFixed(4)} of a US$${(BUDGET_MICROS / 1e6).toFixed(2)} budget; ${failures} calls failed.`,
    "",
    "| file | status | message | cost | ms |",
    "|---|---|---|---|---|",
    ...rows.sort(),
    "",
  ].join("\n");
  writeFileSync(join(outDir, "summary.md"), table);
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  return failures === 0;
}

const outDir = process.argv[2];
if (!outDir) throw new Error("Usage: record-language.ts <empty output dir>");
try {
  process.exitCode = (await main(resolve(outDir))) ? 0 : 1;
} finally {
  await endPools();
}
