/**
 * Records how people actually phrase local-business searches, so the fallback question templates
 * follow real queries: DataForSEO Labs keyword suggestions (Google volumes), Google "People also
 * ask" and related searches, Google autocomplete, AI-search volume and the questions that brought
 * up a Google AI Overview (LLM Mentions).
 *
 * Usage: pnpm --filter @reranker/capture record:phrasing <empty output dir>
 * Each file holds a response's exact wire bytes. Every call is charged to the spend ledger as
 * `contract-test`, and the run refuses to start above its budget.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { endPools } from "@reranker/db";
import { releaseSpend, reserveSpend, settleSpend } from "@reranker/jobs";
import { costFromMajor, type ProviderCost } from "@reranker/schema";
import {
  AiOptimizationAiKeywordDataKeywordsSearchVolumeLiveRequestInfo,
  AiOptimizationLLmMentionsKeywordElement,
  AiOptimizationLlmMentionsSearchMentionsLiveRequestInfo,
  DataforseoLabsGoogleKeywordSuggestionsLiveRequestInfo,
  SerpGoogleAutocompleteLiveAdvancedRequestInfo,
  SerpGoogleOrganicLiveAdvancedRequestInfo,
} from "dataforseo-client";
import { createDataForSeo } from "../src/dataforseo/client";
import { RawSink } from "../src/raw/raw-sink";

type Market = "co" | "mx" | "es" | "ar";

// Google Ads location codes; the city goes in the query, as people type it.
const MARKETS: Record<Market, { location: number; city: string }> = {
  co: { location: 2170, city: "Medellín" },
  mx: { location: 2484, city: "Ciudad de México" },
  es: { location: 2724, city: "Madrid" },
  ar: { location: 2032, city: "Buenos Aires" },
};

const NATIONAL = "online_national";

// Two or three nouns per archetype in Colombia; elsewhere the one most used there.
const NOUNS: Record<Market, Record<string, string[]>> = {
  co: {
    health: ["odontólogo", "dentista", "clínica odontológica"],
    beauty_wellness: ["peluquería", "barbería", "spa"],
    lodging: ["hotel", "hostal"],
    food: ["restaurante", "panadería"],
    home_auto_services: ["taller mecánico", "plomero", "cerrajero"],
    local_retail: ["ferretería", "floristería", "tienda de ropa"],
    professional_services: ["abogado", "contador"],
    real_estate: ["inmobiliaria", "agente inmobiliario"],
    education: ["colegio", "curso de inglés", "jardín infantil"],
    [NATIONAL]: ["tienda online", "comprar ropa online"],
  },
  mx: {
    health: ["dentista"],
    beauty_wellness: ["estética"],
    lodging: ["hotel"],
    food: ["restaurante"],
    home_auto_services: ["taller mecánico"],
    local_retail: ["ferretería"],
    professional_services: ["abogado"],
    real_estate: ["inmobiliaria"],
    education: ["escuela"],
    [NATIONAL]: ["tienda en línea"],
  },
  es: {
    health: ["dentista"],
    beauty_wellness: ["peluquería"],
    lodging: ["hotel"],
    food: ["restaurante"],
    home_auto_services: ["taller mecánico"],
    local_retail: ["ferretería"],
    professional_services: ["abogado"],
    real_estate: ["inmobiliaria"],
    education: ["colegio"],
    [NATIONAL]: ["tienda online"],
  },
  ar: {
    health: ["dentista"],
    beauty_wellness: ["peluquería"],
    lodging: ["hotel"],
    food: ["restaurante"],
    home_auto_services: ["taller mecánico"],
    local_retail: ["ferretería"],
    professional_services: ["abogado"],
    real_estate: ["inmobiliaria"],
    education: ["colegio"],
    [NATIONAL]: ["tienda online"],
  },
};

// Openings that show the register (tú or usted) and how people start a request.
const OPENINGS = [
  "me recomiendas ",
  "me recomienda ",
  "recomiéndame ",
  "recomiéndeme ",
  "qué me recomiendas ",
  "qué me recomienda ",
  "cuál es el mejor ",
  "dónde puedo ",
  "necesito un ",
  "busco ",
];

// Keyword ideas that are questions or ask for a recommendation; at most eight conditions.
const QUESTION_FILTER = [
  ["keyword", "like", "que %"],
  "or",
  ["keyword", "like", "qué %"],
  "or",
  ["keyword", "like", "cual %"],
  "or",
  ["keyword", "like", "cuál %"],
  "or",
  ["keyword", "like", "donde %"],
  "or",
  ["keyword", "like", "dónde %"],
  "or",
  ["keyword", "like", "%recomiend%"],
  "or",
  ["keyword", "like", "%recomend%"],
];

// Phrasings the templates could take, checked for AI-search volume in every market.
function candidates(noun: string, city: string): string[] {
  return [
    `${noun} en ${city}`,
    `${noun} ${city}`,
    `mejor ${noun} en ${city}`,
    `mejores ${noun} en ${city}`,
    `${noun} cerca de mi`,
    `${noun} recomendado en ${city}`,
    `${noun} barato en ${city}`,
    `${noun} de confianza en ${city}`,
    `${noun} 24 horas ${city}`,
    `cuál es el mejor ${noun} en ${city}`,
    `qué ${noun} me recomiendas en ${city}`,
    `qué ${noun} me recomienda en ${city}`,
    `recomiéndame ${noun} en ${city}`,
    `recomiéndeme ${noun} en ${city}`,
    `dónde encuentro ${noun} en ${city}`,
  ];
}

const usd = (major: number) => costFromMajor(major.toFixed(6), "USD");

// DataForSEO list prices (https://dataforseo.com/apis, read 2026-11-19): upper bounds per call.
const PRICE = {
  labs: (items: number) => usd(0.012 + 0.00012 * items),
  serp: usd(0.002),
  autocomplete: usd(0.002),
  aiVolume: (keywords: number) => usd(0.01 + 0.0001 * keywords),
  mentions: (rows: number) => usd(0.1 + 0.001 * rows),
};

// A hard ceiling for the whole run; the ledger's contract-test cap is the second one.
const BUDGET_MICROS = 4_500_000;
const CONCURRENCY = 6;
const MENTIONS_ROWS = 20;
const AI_VOLUME_MAX = 1000;

type Clients = ReturnType<typeof createDataForSeo>;
type Call = {
  file: string;
  estimate: ProviderCost;
  run: (c: Clients) => Promise<unknown>;
};

const slug = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const localNouns = (m: Market) =>
  Object.entries(NOUNS[m]).flatMap(([archetype, nouns]) =>
    nouns.map((noun) => ({ archetype, noun, local: archetype !== NATIONAL })),
  );

function labs(m: Market, noun: string, limit: number, questions: boolean): Call {
  return {
    file: `labs-${questions ? "questions" : "suggestions"}/${m}-${slug(noun)}.json`,
    estimate: PRICE.labs(limit),
    run: (c) =>
      c.labs.googleKeywordSuggestionsLive([
        new DataforseoLabsGoogleKeywordSuggestionsLiveRequestInfo({
          keyword: noun,
          location_code: MARKETS[m].location,
          language_code: "es",
          include_seed_keyword: true,
          limit,
          order_by: ["keyword_info.search_volume,desc"],
          ...(questions ? { filters: QUESTION_FILTER } : {}),
        }),
      ]),
  };
}

function serp(m: Market, keyword: string): Call {
  return {
    file: `serp/${m}-${slug(keyword)}.json`,
    estimate: PRICE.serp,
    run: (c) =>
      c.serp.googleOrganicLiveAdvanced([
        new SerpGoogleOrganicLiveAdvancedRequestInfo({
          keyword,
          location_code: MARKETS[m].location,
          language_code: "es",
          device: "mobile",
        }),
      ]),
  };
}

function autocomplete(m: Market, keyword: string): Call {
  return {
    file: `autocomplete/${m}-${slug(keyword)}.json`,
    estimate: PRICE.autocomplete,
    run: (c) =>
      c.serp.googleAutocompleteLiveAdvanced([
        new SerpGoogleAutocompleteLiveAdvancedRequestInfo({
          keyword,
          location_code: MARKETS[m].location,
          language_code: "es",
          client: "chrome-omni",
        }),
      ]),
  };
}

function aiVolume(m: Market, keywords: string[]): Call {
  return {
    file: `ai-volume/${m}.json`,
    estimate: PRICE.aiVolume(keywords.length),
    run: (c) =>
      c.ai.aiKeywordDataKeywordsSearchVolumeLive([
        new AiOptimizationAiKeywordDataKeywordsSearchVolumeLiveRequestInfo({
          keywords,
          location_code: MARKETS[m].location,
          language_code: "es",
        }),
      ]),
  };
}

function mentions(m: Market, noun: string): Call {
  return {
    file: `llm-mentions/${m}-${slug(noun)}.json`,
    estimate: PRICE.mentions(MENTIONS_ROWS),
    run: (c) =>
      c.ai.llmMentionsSearchMentionsLive([
        new AiOptimizationLlmMentionsSearchMentionsLiveRequestInfo({
          target: [
            new AiOptimizationLLmMentionsKeywordElement({
              keyword: noun,
              search_scope: ["question"],
              match_type: "word_match",
            }),
          ],
          location_code: MARKETS[m].location,
          language_code: "es",
          platform: "google",
          order_by: ["ai_search_volume,desc"],
          limit: MENTIONS_ROWS,
        }),
      ]),
  };
}

function searchCalls(): Call[] {
  const calls: Call[] = [];
  for (const m of Object.keys(MARKETS) as Market[]) {
    const { city } = MARKETS[m];
    const co = m === "co";
    for (const { noun, local } of localNouns(m)) {
      calls.push(labs(m, noun, co ? 100 : 60, false));
      if (co || m === "mx") calls.push(labs(m, noun, 50, true));
      calls.push(serp(m, local ? `${noun} en ${city}` : noun));
      if (co) calls.push(serp(m, local ? `mejor ${noun} en ${city}` : `mejor ${noun}`));
      calls.push(autocomplete(m, `${noun} `), autocomplete(m, `mejor ${noun} `));
      if (local) calls.push(autocomplete(m, `${noun} en `));
      if (co) calls.push(autocomplete(m, `qué ${noun} `));
    }
    for (const opening of OPENINGS) calls.push(autocomplete(m, opening));
  }
  return calls;
}

function json(bytes: Uint8Array | null): unknown {
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

type Envelope = {
  status_code?: number;
  cost?: number;
  tasks?: { status_code?: number; status_message?: string; cost?: number; result?: unknown[] }[];
};

function labsKeywords(body: unknown): { keyword: string; volume: number }[] {
  const items = (body as Envelope | null)?.tasks?.[0]?.result?.flatMap(
    (r) => (r as { items?: unknown[] }).items ?? [],
  );
  return (items ?? []).flatMap((item) => {
    const i = item as { keyword?: string; keyword_info?: { search_volume?: number | null } };
    return i.keyword ? [{ keyword: i.keyword, volume: i.keyword_info?.search_volume ?? 0 }] : [];
  });
}

type Outcome = { status: unknown; message: unknown; cost: number | null; body: unknown };

async function record(outDir: string, refId: string, call: Call): Promise<Outcome> {
  const reservation = await reserveSpend({
    provider: "dataforseo",
    purpose: "contract-test",
    refType: "query-phrasing",
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
  const bytes = sink.response;
  if (bytes !== null) writeFileSync(join(outDir, call.file), bytes);
  const body = json(bytes) as Envelope | null;
  const task = body?.tasks?.[0];
  const cost = task?.cost ?? body?.cost;
  if (typeof cost === "number") await settleSpend(reservation, usd(cost));
  else await releaseSpend(reservation);
  return {
    status: task?.status_code ?? body?.status_code ?? "no response",
    message: task?.status_message ?? "",
    cost: typeof cost === "number" ? cost : null,
    body,
  };
}

async function main(outDir: string): Promise<boolean> {
  mkdirSync(outDir, { recursive: true });
  if (readdirSync(outDir).length > 0) throw new Error(`${outDir} is not empty`);
  for (const dir of ["labs-suggestions", "labs-questions", "serp", "autocomplete"]) {
    mkdirSync(join(outDir, dir));
  }
  mkdirSync(join(outDir, "ai-volume"));
  mkdirSync(join(outDir, "llm-mentions"));

  const markets = Object.keys(MARKETS) as Market[];
  const search = searchCalls();
  const archetypes = Object.keys(NOUNS.co);
  const estimate =
    search.reduce((t, c) => t + c.estimate.amount_micros, 0) +
    markets.length * PRICE.aiVolume(AI_VOLUME_MAX).amount_micros +
    (archetypes.length + 2) * PRICE.mentions(MENTIONS_ROWS).amount_micros;
  if (estimate > BUDGET_MICROS)
    throw new Error(`Estimated ${estimate} micro-USD exceeds the budget`);

  const refId = randomUUID();
  const rows: string[] = [];
  let spent = 0;
  let failures = 0;
  const log = (file: string, o: Outcome, probe = false) => {
    spent += o.cost ?? 0;
    if (o.status !== 20000 && !probe) failures += 1;
    rows.push(
      `| ${file} | ${o.status} | ${o.status === 20000 ? "" : o.message} | ${o.cost ?? ""} |`,
    );
  };

  const ideas = new Map<Market, Map<string, number>>(markets.map((m) => [m, new Map()]));
  const queue = [...search];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let call = queue.shift(); call; call = queue.shift()) {
        const o = await record(outDir, refId, call);
        log(call.file, o);
        if (call.file.startsWith("labs-")) {
          const m = call.file.split("/")[1]?.slice(0, 2) as Market;
          for (const { keyword, volume } of labsKeywords(o.body))
            ideas.get(m)?.set(keyword, volume);
        }
      }
    }),
  );

  // The most searched keyword forms and the template phrasings, in AI search.
  for (const m of markets) {
    const own = localNouns(m).flatMap(({ noun, local }) =>
      local ? candidates(noun, MARKETS[m].city) : [noun, `mejor ${noun}`, `${noun} confiable`],
    );
    const found = [...(ideas.get(m) ?? new Map<string, number>())]
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
    const keywords = [...new Set([...own, ...found].map((k) => k.toLowerCase()))].slice(
      0,
      AI_VOLUME_MAX,
    );
    const call = aiVolume(m, keywords);
    log(call.file, await record(outDir, refId, call));
  }

  // LLM Mentions covers few locations; the first market it answers for gets every archetype.
  const fallbacks = ["co", "mx", "es"] as const;
  for (const m of fallbacks) {
    const first = mentions(m, NOUNS[m][archetypes[0] ?? "health"]?.[0] ?? "");
    const o = await record(outDir, refId, first);
    log(first.file, o, m !== fallbacks.at(-1));
    if (o.status !== 20000) continue;
    for (const archetype of archetypes.slice(1)) {
      const call = mentions(m, NOUNS[m][archetype]?.[0] ?? archetype);
      log(call.file, await record(outDir, refId, call));
    }
    break;
  }

  const table = [
    `Spent US$${spent.toFixed(4)} of a US$${(BUDGET_MICROS / 1e6).toFixed(2)} budget; ${failures} calls failed.`,
    "",
    "| file | status | message | cost |",
    "|---|---|---|---|",
    ...rows.sort(),
    "",
  ].join("\n");
  writeFileSync(join(outDir, "summary.md"), table);
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  return failures === 0;
}

const outDir = process.argv[2];
if (!outDir) throw new Error("Usage: record-phrasing.ts <empty output dir>");
try {
  process.exitCode = (await main(resolve(outDir))) ? 0 : 1;
} finally {
  await endPools();
}
