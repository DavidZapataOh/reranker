// Regenerates src/countries/generated.ts from the providers' official coverage lists.
// Usage: pnpm --filter @reranker/i18n generate:countries
import { writeFileSync } from "node:fs";

const OUTPUT = new URL("../src/countries/generated.ts", import.meta.url);

const DATAFORSEO_SERP_DOCS = "https://docs.dataforseo.com/v3/serp/google/locations/";
const DATAFORSEO_CHATGPT_DOCS =
  "https://docs.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/locations/";
const BRIGHTDATA_REPO = "brightdata/answer-engines-country-codes";
const IANA_TZDB = "https://data.iana.org/time-zones/tzdb/";

// V0 engine → provider lists that can capture it. DataForSEO's Gemini LLM Scraper locations
// are only served to authenticated API calls, so Gemini coverage comes from Bright Data alone.
type EngineId = "chatgpt" | "gemini" | "google-ai-overview" | "perplexity";
const BRIGHTDATA_ENGINES = {
  chatgpt: "chatgpt_countries.csv",
  gemini: "gemini_countries.csv",
  perplexity: "perplexity_countries.csv",
} as const satisfies Partial<Record<EngineId, string>>;

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return response.text();
}

// RFC 4180: DataForSEO quotes names that contain commas.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows.map((cells) => cells.map((cell) => cell.trim()));
}

function linkedCsv(docsHtml: string, prefix: string): string {
  const pattern = new RegExp(
    `https://cdn\\.dataforseo\\.com/v3/locations/${prefix}_\\d{4}_\\d{2}_\\d{2}\\.csv`,
  );
  const match = docsHtml.match(pattern);
  if (!match) throw new Error(`No ${prefix} CSV linked from the DataForSEO docs`);
  return match[0];
}

function assertIso2(code: string, source: string): string {
  if (!/^[A-Z]{2}$/.test(code)) throw new Error(`Invalid country code "${code}" in ${source}`);
  return code;
}

async function dataforseoLocations(docsUrl: string, prefix: string, types: readonly string[]) {
  const csvUrl = linkedCsv(await fetchText(docsUrl), prefix);
  const [header, ...rows] = parseCsv(await fetchText(csvUrl));
  const columns = [
    "location_code",
    "location_name",
    "location_code_parent",
    "country_iso_code",
    "location_type",
  ];
  if (header?.join(",") !== columns.join(",")) throw new Error(`Unexpected header in ${csvUrl}`);
  const byCountry = new Map<string, number>();
  for (const [code = "", , , iso = "", type = ""] of rows) {
    if (!types.includes(type)) continue;
    const country = assertIso2(iso, csvUrl);
    if (byCountry.has(country)) throw new Error(`Duplicate ${country} in ${csvUrl}`);
    byCountry.set(country, Number(code));
  }
  return { url: csvUrl, rows: rows.length, byCountry };
}

async function brightdataCountries() {
  const commit = JSON.parse(
    await fetchText(`https://api.github.com/repos/${BRIGHTDATA_REPO}/commits/main`, {
      headers: { accept: "application/vnd.github+json" },
    }),
  ) as { sha: string };
  const lists = {} as Record<keyof typeof BRIGHTDATA_ENGINES, { url: string; codes: Set<string> }>;
  for (const [engine, file] of Object.entries(BRIGHTDATA_ENGINES)) {
    const url = `https://raw.githubusercontent.com/${BRIGHTDATA_REPO}/${commit.sha}/${file}`;
    const [, ...rows] = parseCsv(await fetchText(url));
    const codes = new Set(rows.map(([code = ""]) => assertIso2(code, url)));
    lists[engine as keyof typeof BRIGHTDATA_ENGINES] = { url, codes };
  }
  return { commit: commit.sha, lists };
}

// zone.tab lists one country per line (zone1970.tab merges countries that share a zone).
async function firstZones() {
  const version = (await fetchText(`${IANA_TZDB}version`)).trim();
  const url = `${IANA_TZDB}zone.tab`;
  const zones = new Map<string, string>();
  for (const line of (await fetchText(url)).split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const [country = "", , zone = ""] = line.split("\t");
    if (!zones.has(country)) zones.set(assertIso2(country, url), zone);
  }
  return { url, version, zones };
}

const fetchedOn = new Date().toISOString().slice(0, 10);
const [serp, chatgpt, brightdata, tz] = await Promise.all([
  dataforseoLocations(DATAFORSEO_SERP_DOCS, "locations_serp_google", ["Country"]),
  // Taiwan and Hong Kong are listed as regions but targeted as countries.
  dataforseoLocations(DATAFORSEO_CHATGPT_DOCS, "locations_ai_optimization_chat_gpt_llm_scraper", [
    "Country",
    "Region",
  ]),
  brightdataCountries(),
  firstZones(),
]);

const names = new Intl.DisplayNames(["es-CO"], { type: "region", fallback: "none" });
const skipped: string[] = [];
const entries: string[] = [];

for (const country of [...serp.byCountry.keys()].sort()) {
  const timeZone = tz.zones.get(country);
  const name = names.of(country);
  if (!timeZone || !name) {
    skipped.push(`${country} (${timeZone ? "no CLDR name" : "no IANA time zone"})`);
    continue;
  }
  const inBrightdata = (engine: keyof typeof BRIGHTDATA_ENGINES) =>
    brightdata.lists[engine].codes.has(country);
  const engines: EngineId[] = [];
  if (chatgpt.byCountry.has(country) || inBrightdata("chatgpt")) engines.push("chatgpt");
  if (inBrightdata("gemini")) engines.push("gemini");
  // Every row comes from DataForSEO's Google SERP list, which captures AI Overviews.
  engines.push("google-ai-overview");
  if (inBrightdata("perplexity")) engines.push("perplexity");
  const brightdataListed = Object.values(brightdata.lists).some((list) => list.codes.has(country));
  entries.push(
    [
      `  ${country}: {`,
      `    name: ${JSON.stringify(name)},`,
      `    timeZone: ${JSON.stringify(timeZone)},`,
      `    dataforseoLocationCode: ${serp.byCountry.get(country)},`,
      ...(brightdataListed ? [`    brightdataCountry: "${country}",`] : []),
      `    engines: [${engines.map((engine) => `"${engine}"`).join(", ")}],`,
      "  },",
    ].join("\n"),
  );
}

const header = [
  "// Generated by scripts/generate-countries.ts. Do not edit; rerun the script instead.",
  `// Fetched ${fetchedOn}:`,
  `// - Countries and location codes: ${serp.url} (${serp.rows} rows, ${serp.byCountry.size} countries)`,
  `// - ChatGPT: ${chatgpt.url} (${chatgpt.rows} rows)`,
  ...Object.entries(brightdata.lists).map(
    ([engine, list]) => `// - Bright Data ${engine}: ${list.url} (${list.codes.size} countries)`,
  ),
  `// - Time zones: ${tz.url} (tzdb ${tz.version}), first zone listed per country`,
  `// - Spanish names: CLDR ${process.versions.cldr} (es-CO)`,
  ...(skipped.length > 0 ? [`// Skipped: ${skipped.join(", ")}`] : []),
];

writeFileSync(
  OUTPUT,
  `${header.join("\n")}\nexport const PROVIDER_COVERAGE = {\n${entries.join("\n")}\n} as const;\n`,
);
console.log(`Wrote ${entries.length} countries to ${OUTPUT.pathname}`);
