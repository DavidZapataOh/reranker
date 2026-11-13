// Regenerates src/countries/generated.ts from the providers' official coverage lists.
// Usage: pnpm --filter @reranker/i18n generate:countries
import { writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { UNINHABITED_TERRITORIES } from "../src/countries/policy.ts";
import type { EngineId } from "../src/engines.ts";
import { DEFAULT_LOCALE } from "../src/locales.ts";

const OUTPUT = new URL("../src/countries/generated.ts", import.meta.url);

const DATAFORSEO_SERP_DOCS = "https://docs.dataforseo.com/v3/serp/google/locations/";
const DATAFORSEO_CHATGPT_DOCS =
  "https://docs.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/locations/";
const BRIGHTDATA_REPO = "brightdata/answer-engines-country-codes";
const IANA_TZDB = "https://data.iana.org/time-zones/tzdb/";
const GEONAMES_CITIES = "https://download.geonames.org/export/dump/cities15000.zip";

// V0 engine → provider lists that can capture it. DataForSEO's Gemini LLM Scraper locations
// are only served to authenticated API calls, so Gemini coverage comes from Bright Data alone.
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
async function zonesByCountry() {
  const version = (await fetchText(`${IANA_TZDB}version`)).trim();
  const url = `${IANA_TZDB}zone.tab`;
  const zones = new Map<string, string[]>();
  for (const line of (await fetchText(url)).split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const [country = "", , zone = ""] = line.split("\t");
    const list = zones.get(assertIso2(country, url)) ?? [];
    zones.set(country, [...list, zone]);
  }
  return { url, version, zones };
}

// The archive holds a single deflated file; its sizes live in the central directory.
function unzipSingleFile(archive: Buffer): Buffer {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("Not a zip archive");
  const entry = archive.readUInt32LE(end + 16);
  const method = archive.readUInt16LE(entry + 10);
  const size = archive.readUInt32LE(entry + 20);
  const local = archive.readUInt32LE(entry + 42);
  const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
  const data = archive.subarray(start, start + size);
  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported zip compression method ${method}`);
}

// A country's working hours follow its capital; zone.tab's first zone is often a remote
// island (Brazil → Noronha, Australia → Lord Howe).
async function capitalZones() {
  const response = await fetch(GEONAMES_CITIES);
  if (!response.ok) throw new Error(`GET ${GEONAMES_CITIES} answered ${response.status}`);
  const lastModified = response.headers.get("last-modified") ?? "unknown";
  const text = unzipSingleFile(Buffer.from(await response.arrayBuffer())).toString("utf8");
  const zones = new Map<string, string>();
  let rows = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    rows++;
    const columns = line.split("\t");
    const [featureCode = "", country = ""] = [columns[7], columns[8]];
    const zone = columns[17] ?? "";
    if (featureCode !== "PPLC") continue;
    if (zones.has(country)) throw new Error(`Two capitals for ${country} in ${GEONAMES_CITIES}`);
    zones.set(assertIso2(country, GEONAMES_CITIES), zone);
  }
  return { url: GEONAMES_CITIES, lastModified, rows, zones };
}

const fetchedOn = new Date().toISOString().slice(0, 10);
const [serp, chatgpt, brightdata, tz, capitals] = await Promise.all([
  dataforseoLocations(DATAFORSEO_SERP_DOCS, "locations_serp_google", ["Country"]),
  // Taiwan and Hong Kong are listed as regions but targeted as countries.
  dataforseoLocations(DATAFORSEO_CHATGPT_DOCS, "locations_ai_optimization_chat_gpt_llm_scraper", [
    "Country",
    "Region",
  ]),
  brightdataCountries(),
  zonesByCountry(),
  capitalZones(),
]);

const names = new Intl.DisplayNames([DEFAULT_LOCALE], { type: "region", fallback: "none" });
const skipped: string[] = [];
const unresolved: string[] = [];
const entries: string[] = [];

for (const country of [...serp.byCountry.keys()].sort()) {
  if ((UNINHABITED_TERRITORIES as readonly string[]).includes(country)) {
    skipped.push(country);
    continue;
  }
  const zones = tz.zones.get(country) ?? [];
  // GeoNames can give a capital another country's zone (Hanoi → Asia/Bangkok).
  const capitalZone = capitals.zones.get(country);
  const timeZone =
    capitalZone && zones.includes(capitalZone)
      ? capitalZone
      : zones.length === 1
        ? zones[0]
        : undefined;
  const name = names.of(country);
  if (!timeZone || !name) {
    unresolved.push(
      `${country} (${name ? `zones: ${zones.join(", ") || "none"}` : "no CLDR name"})`,
    );
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

if (unresolved.length > 0) {
  throw new Error(`No single time zone or name for: ${unresolved.join("; ")}`);
}

const header = [
  "// Generated by scripts/generate-countries.ts. Do not edit; rerun the script instead.",
  `// Fetched ${fetchedOn}:`,
  `// - Countries and location codes: ${serp.url} (${serp.rows} rows, ${serp.byCountry.size} countries)`,
  `// - ChatGPT: ${chatgpt.url} (${chatgpt.rows} rows)`,
  ...Object.entries(brightdata.lists).map(
    ([engine, list]) => `// - Bright Data ${engine}: ${list.url} (${list.codes.size} countries)`,
  ),
  `// - Time zones: capital (PPLC) of ${capitals.url} (${capitals.rows} rows, ${capitals.zones.size} capitals, last modified ${capitals.lastModified});`,
  `//   when it is one of the country's zones in ${tz.url} (tzdb ${tz.version}), otherwise its only zone`,
  `// - Spanish names: CLDR ${process.versions.cldr} (${DEFAULT_LOCALE})`,
  ...(skipped.length > 0
    ? [`// Skipped as uninhabited territories (policy.ts): ${skipped.join(", ")}`]
    : []),
];

writeFileSync(
  OUTPUT,
  `${header.join("\n")}\nexport const PROVIDER_COVERAGE = {\n${entries.join("\n")}\n} as const;\n`,
);
console.log(`Wrote ${entries.length} countries to ${OUTPUT.pathname}`);
