/**
 * Records how people actually phrase local-business searches, so the fallback question templates
 * follow real queries: DataForSEO Labs keyword suggestions (Google volumes), Google "People also
 * ask" and related searches, Google autocomplete, AI-search volume and the questions that brought
 * up a Google AI Overview (LLM Mentions).
 *
 * Usage: pnpm --filter @reranker/capture record:phrasing <empty output dir> [es|en]
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

type Language = "es" | "en";

const NATIONAL = "online_national";

type MarketPlan = {
  /** Google Ads location code; the city goes in the query, as people type it. */
  location: number;
  /** The first city also gets the deeper calls. */
  cities: string[];
  labsLimit: number;
  questions: boolean;
  deep: boolean;
  nouns: Record<string, string[]>;
};

type Phrasing = {
  /** Keyword ideas that are questions or ask for a recommendation; at most eight conditions. */
  questionFilter: unknown[];
  /** Openings that show the register and how people start a request. */
  openings: string[];
  local: (noun: string, city: string) => string;
  best: (noun: string, city: string | null) => string;
  /** Autocomplete prefixes: for every noun, for local nouns, and on the deepest market only. */
  prefixes: (noun: string) => { all: string[]; local: string[]; deep: string[] };
  /** Phrasings the templates could take, checked for AI-search volume in every market. */
  candidates: (noun: string, city: string) => string[];
  national: (noun: string) => string[];
};

type Plan = {
  phrasing: Phrasing;
  markets: Record<string, MarketPlan>;
  /** LLM Mentions covers few locations; the first market it answers for gets every archetype. */
  mentions: string[];
  /** AI-volume requests per market: two cities of candidate phrasings fill one on their own. */
  aiVolumeCalls: number;
};

const PLANS: Record<Language, Plan> = {
  es: {
    markets: {
      // Two or three nouns per archetype in Colombia; elsewhere the one most used there.
      co: {
        location: 2170,
        cities: ["Medellín"],
        labsLimit: 100,
        questions: true,
        deep: true,
        nouns: {
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
      },
      mx: {
        location: 2484,
        cities: ["Ciudad de México"],
        labsLimit: 60,
        questions: true,
        deep: false,
        nouns: {
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
      },
      es: {
        location: 2724,
        cities: ["Madrid"],
        labsLimit: 60,
        questions: false,
        deep: false,
        nouns: {
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
      },
      ar: {
        location: 2032,
        cities: ["Buenos Aires"],
        labsLimit: 60,
        questions: false,
        deep: false,
        nouns: {
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
      },
    },
    mentions: ["co", "mx", "es"],
    aiVolumeCalls: 1,
    phrasing: {
      questionFilter: [
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
      ],
      openings: [
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
      ],
      local: (noun, city) => `${noun} en ${city}`,
      best: (noun, city) => (city ? `mejor ${noun} en ${city}` : `mejor ${noun}`),
      prefixes: (noun) => ({
        all: [`${noun} `, `mejor ${noun} `],
        local: [`${noun} en `],
        deep: [`qué ${noun} `],
      }),
      candidates: (noun, city) => [
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
      ],
      national: (noun) => [noun, `mejor ${noun}`, `${noun} confiable`],
    },
  },
  en: {
    markets: {
      // Miami has a large Spanish-speaking population and Chicago a smaller one.
      us: {
        location: 2840,
        cities: ["Miami", "Chicago"],
        labsLimit: 100,
        questions: true,
        deep: true,
        // Several candidates where a seed category's English noun is still open.
        nouns: {
          health: ["dentist", "dental clinic", "dental office"],
          beauty_wellness: ["hair salon", "barber shop", "spa"],
          lodging: ["hotel", "motel"],
          food: ["restaurant", "bakery"],
          home_auto_services: ["auto repair", "car repair", "mechanic", "plumber"],
          local_retail: ["hardware store", "florist", "clothing store"],
          professional_services: ["lawyer", "attorney", "accountant"],
          real_estate: ["realtor", "real estate agent", "real estate agency"],
          education: ["private school", "daycare", "tutor"],
          [NATIONAL]: ["online store", "buy clothes online"],
        },
      },
      gb: {
        location: 2826,
        cities: ["London"],
        labsLimit: 60,
        questions: true,
        deep: false,
        nouns: {
          health: ["dentist"],
          beauty_wellness: ["hairdresser"],
          lodging: ["hotel"],
          food: ["restaurant"],
          home_auto_services: ["garage"],
          local_retail: ["hardware shop"],
          professional_services: ["solicitor"],
          real_estate: ["estate agent"],
          education: ["private school"],
          [NATIONAL]: ["online shop"],
        },
      },
    },
    mentions: ["us"],
    aiVolumeCalls: 2,
    phrasing: {
      questionFilter: [
        ["keyword", "like", "what %"],
        "or",
        ["keyword", "like", "which %"],
        "or",
        ["keyword", "like", "where %"],
        "or",
        ["keyword", "like", "who %"],
        "or",
        ["keyword", "like", "how %"],
        "or",
        ["keyword", "like", "is %"],
        "or",
        ["keyword", "like", "can %"],
        "or",
        ["keyword", "like", "%recommend%"],
      ],
      openings: [
        "can you recommend a ",
        "can you recommend ",
        "recommend a ",
        "recommend me a ",
        "what is the best ",
        "who is the best ",
        "where can i find a ",
        "where can i get ",
        "i need a ",
        "looking for a ",
        "top rated ",
        "suggest a ",
        "any good ",
      ],
      local: (noun, city) => `${noun} in ${city}`,
      best: (noun, city) => (city ? `best ${noun} in ${city}` : `best ${noun}`),
      prefixes: (noun) => ({
        all: [`${noun} `, `best ${noun} `],
        local: [`${noun} in `, `${noun} near `],
        deep: [`which ${noun} `, `${noun} that `],
      }),
      candidates: (noun, city) => [
        `${noun} in ${city}`,
        `${noun} ${city}`,
        `best ${noun} in ${city}`,
        `best ${noun} ${city}`,
        `${noun} near me`,
        `good ${noun} in ${city}`,
        `top rated ${noun} in ${city}`,
        `affordable ${noun} in ${city}`,
        `cheap ${noun} in ${city}`,
        `${noun} open now`,
        `24 hour ${noun} ${city}`,
        `emergency ${noun} ${city}`,
        `${noun} reviews ${city}`,
        `spanish speaking ${noun} ${city}`,
        `what is the best ${noun} in ${city}`,
        `which ${noun} do you recommend in ${city}`,
        `can you recommend a ${noun} in ${city}`,
        `recommend a ${noun} in ${city}`,
        `where can i find a ${noun} in ${city}`,
      ],
      national: (noun) => [noun, `best ${noun}`, `${noun} reviews`, `trusted ${noun}`],
    },
  },
};

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
// Keywords per AI-volume request.
const AI_VOLUME_MAX = 1000;

type Clients = ReturnType<typeof createDataForSeo>;
type Call = {
  file: string;
  market: string;
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

const localNouns = (market: MarketPlan) =>
  Object.entries(market.nouns).flatMap(([archetype, nouns]) =>
    nouns.map((noun) => ({ archetype, noun, local: archetype !== NATIONAL })),
  );

function makeCalls(language: Language) {
  const { markets, phrasing, aiVolumeCalls } = PLANS[language];
  const target = (m: string) => ({ location_code: markets[m]?.location, language_code: language });

  const labs = (m: string, noun: string, limit: number, questions: boolean): Call => ({
    file: `labs-${questions ? "questions" : "suggestions"}/${m}-${slug(noun)}.json`,
    market: m,
    estimate: PRICE.labs(limit),
    run: (c) =>
      c.labs.googleKeywordSuggestionsLive([
        new DataforseoLabsGoogleKeywordSuggestionsLiveRequestInfo({
          keyword: noun,
          ...target(m),
          include_seed_keyword: true,
          limit,
          order_by: ["keyword_info.search_volume,desc"],
          ...(questions ? { filters: phrasing.questionFilter } : {}),
        }),
      ]),
  });

  const serp = (m: string, keyword: string): Call => ({
    file: `serp/${m}-${slug(keyword)}.json`,
    market: m,
    estimate: PRICE.serp,
    run: (c) =>
      c.serp.googleOrganicLiveAdvanced([
        new SerpGoogleOrganicLiveAdvancedRequestInfo({ keyword, ...target(m), device: "mobile" }),
      ]),
  });

  const autocomplete = (m: string, keyword: string): Call => ({
    file: `autocomplete/${m}-${slug(keyword)}.json`,
    market: m,
    estimate: PRICE.autocomplete,
    run: (c) =>
      c.serp.googleAutocompleteLiveAdvanced([
        new SerpGoogleAutocompleteLiveAdvancedRequestInfo({
          keyword,
          ...target(m),
          client: "chrome-omni",
        }),
      ]),
  });

  const aiVolume = (m: string, part: number, keywords: string[]): Call => ({
    file: `ai-volume/${m}-${part}.json`,
    market: m,
    estimate: PRICE.aiVolume(keywords.length),
    run: (c) =>
      c.ai.aiKeywordDataKeywordsSearchVolumeLive([
        new AiOptimizationAiKeywordDataKeywordsSearchVolumeLiveRequestInfo({
          keywords,
          ...target(m),
        }),
      ]),
  });

  const mentions = (m: string, noun: string): Call => ({
    file: `llm-mentions/${m}-${slug(noun)}.json`,
    market: m,
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
          ...target(m),
          platform: "google",
          order_by: ["ai_search_volume,desc"],
          limit: MENTIONS_ROWS,
        }),
      ]),
  });

  function search(): Call[] {
    const calls: Call[] = [];
    for (const [m, market] of Object.entries(markets)) {
      const [first = "", ...others] = market.cities;
      for (const { noun, local } of localNouns(market)) {
        calls.push(labs(m, noun, market.labsLimit, false));
        if (market.questions) calls.push(labs(m, noun, 50, true));
        if (local) {
          for (const city of [first, ...others]) calls.push(serp(m, phrasing.local(noun, city)));
        } else {
          calls.push(serp(m, noun));
        }
        if (market.deep) calls.push(serp(m, phrasing.best(noun, local ? first : null)));
        const prefixes = phrasing.prefixes(noun);
        for (const prefix of [
          ...prefixes.all,
          ...(local ? prefixes.local : []),
          ...(market.deep ? prefixes.deep : []),
        ]) {
          calls.push(autocomplete(m, prefix));
        }
      }
      for (const opening of phrasing.openings) calls.push(autocomplete(m, opening));
    }
    return calls;
  }

  // The template phrasings first, then the most searched keyword ideas.
  function aiVolumes(ideas: Map<string, Map<string, number>>): Call[] {
    return Object.entries(markets).flatMap(([m, market]) => {
      const own = localNouns(market).flatMap(({ noun, local }) =>
        local
          ? market.cities.flatMap((city) => phrasing.candidates(noun, city))
          : phrasing.national(noun),
      );
      const found = [...(ideas.get(m) ?? new Map<string, number>())]
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => k);
      const keywords = [...new Set([...own, ...found].map((k) => k.toLowerCase()))];
      return Array.from({ length: aiVolumeCalls }, (_, i) =>
        keywords.slice(i * AI_VOLUME_MAX, (i + 1) * AI_VOLUME_MAX),
      ).flatMap((chunk, i) => (chunk.length > 0 ? [aiVolume(m, i + 1, chunk)] : []));
    });
  }

  return { search, aiVolumes, mentions };
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

async function main(outDir: string, language: Language): Promise<boolean> {
  mkdirSync(outDir, { recursive: true });
  if (readdirSync(outDir).length > 0) throw new Error(`${outDir} is not empty`);
  for (const dir of [
    "labs-suggestions",
    "labs-questions",
    "serp",
    "autocomplete",
    "ai-volume",
    "llm-mentions",
  ]) {
    mkdirSync(join(outDir, dir));
  }

  const plan = PLANS[language];
  const calls = makeCalls(language);
  const markets = Object.keys(plan.markets);
  const search = calls.search();
  const [primary = ""] = plan.mentions;
  const archetypes = Object.keys(plan.markets[primary]?.nouns ?? {});
  const estimate =
    search.reduce((t, c) => t + c.estimate.amount_micros, 0) +
    markets.length * plan.aiVolumeCalls * PRICE.aiVolume(AI_VOLUME_MAX).amount_micros +
    (archetypes.length + plan.mentions.length - 1) * PRICE.mentions(MENTIONS_ROWS).amount_micros;
  if (estimate > BUDGET_MICROS)
    throw new Error(`Estimated ${estimate} micro-USD exceeds the budget`);
  console.log(`${language}: ${search.length} search calls, estimated ${estimate} micro-USD`);

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

  const ideas = new Map<string, Map<string, number>>(markets.map((m) => [m, new Map()]));
  const queue = [...search];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let call = queue.shift(); call; call = queue.shift()) {
        const o = await record(outDir, refId, call);
        log(call.file, o);
        if (call.file.startsWith("labs-")) {
          for (const { keyword, volume } of labsKeywords(o.body))
            ideas.get(call.market)?.set(keyword, volume);
        }
      }
    }),
  );

  for (const call of calls.aiVolumes(ideas)) log(call.file, await record(outDir, refId, call));

  for (const m of plan.mentions) {
    const nouns = plan.markets[m]?.nouns ?? {};
    const first = calls.mentions(m, nouns[archetypes[0] ?? ""]?.[0] ?? "");
    const o = await record(outDir, refId, first);
    log(first.file, o, m !== plan.mentions.at(-1));
    if (o.status !== 20000) continue;
    for (const archetype of archetypes.slice(1)) {
      const call = calls.mentions(m, nouns[archetype]?.[0] ?? archetype);
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

const [outDir, language = "es"] = process.argv.slice(2);
if (!outDir || !(language in PLANS)) {
  throw new Error("Usage: record-phrasing.ts <empty output dir> [es|en]");
}
try {
  process.exitCode = (await main(resolve(outDir), language as Language)) ? 0 : 1;
} finally {
  await endPools();
}
