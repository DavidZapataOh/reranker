/**
 * Records real businesses from Places, ten per measurement language across the archetypes, as
 * the labelled set category inference is measured on. Each business keeps what inference reads
 * (name, types, Google's labels in its language, country) and the category its Places type says
 * by the reviewed seed and Google's Table A, which a reviewer checks before the set is committed.
 *
 * Usage: pnpm --filter @reranker/extraction record:categories <output file>
 * Every search is charged to the spend ledger as `contract-test`.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { placesTypeArchetype, seedCategories } from "@reranker/catalog";
import { endPools } from "@reranker/db";
import { DEFAULT_COUNTRY_CODE } from "@reranker/i18n/countries";
import type { SpendContext } from "@reranker/jobs";
import type { MeasurementLanguage } from "@reranker/schema/measurement";
import { type PlaceHit, searchText } from "../src/places/client";

const PER_LANGUAGE = 10;
const PER_SEARCH = 2;

// Native searches in each language's main market, one per archetype, so the set covers every
// archetype and the seed and non-seed types in each language. Five searches give ten businesses.
const SEARCHES: Record<MeasurementLanguage, { country: string; queries: string[] }> = {
  es: {
    country: DEFAULT_COUNTRY_CODE,
    queries: [
      "clínica odontológica en Medellín",
      "peluquería en Bogotá",
      "ferretería en Cali",
      "inmobiliaria en Medellín",
      "academia de inglés en Bogotá",
    ],
  },
  en: {
    country: "US",
    queries: [
      "bakery in Chicago",
      "hotel in Miami",
      "accountant in Houston",
      "auto repair in Phoenix",
      "florist in Seattle",
    ],
  },
  pt: {
    country: "BR",
    queries: [
      "padaria em São Paulo",
      "academia de ginástica no Rio de Janeiro",
      "imobiliária em Belo Horizonte",
      "escola de idiomas em Curitiba",
      "oficina mecânica em Porto Alegre",
    ],
  },
  fr: {
    country: "FR",
    queries: [
      "boulangerie à Lyon",
      "cabinet dentaire à Marseille",
      "agence immobilière à Toulouse",
      "salon de coiffure à Nantes",
      "pharmacie à Bordeaux",
    ],
  },
  de: {
    country: "DE",
    queries: [
      "Bäckerei in München",
      "Steuerberater in Hamburg",
      "Hotel in Köln",
      "Fahrschule in Frankfurt",
      "Blumenladen in Stuttgart",
    ],
  },
  it: {
    country: "IT",
    queries: [
      "pasticceria a Milano",
      "ristorante a Napoli",
      "studio legale a Torino",
      "palestra a Bologna",
      "agenzia immobiliare a Firenze",
    ],
  },
};

const seedByType = new Map(seedCategories().flatMap((s) => s.placesTypes.map((t) => [t, s])));

/** The category the Places type says: the seed's, else the Table A type's, else none. */
function expectedOf(hit: PlaceHit) {
  for (const type of [hit.primaryType, ...hit.types]) {
    if (!type) continue;
    const seed = seedByType.get(type);
    if (seed) return { categoryKey: seed.key, archetype: seed.archetype, scope: seed.defaultScope };
    const archetype = placesTypeArchetype(type);
    if (archetype && !["store", "service"].includes(type)) {
      return { categoryKey: `gen:places:${type}`, archetype, scope: "local" as const };
    }
  }
  return null;
}

async function main(out: string): Promise<boolean> {
  // Created before any search is paid for, and never over an earlier recording.
  const file = openSync(out, "wx");
  const spend: SpendContext = {
    purpose: "contract-test",
    refType: "category-recording",
    refId: randomUUID(),
  };
  const businesses = [];
  const short: string[] = [];
  const summary = ["| language | query | kept |", "|---|---|---|"];
  for (const [language, { country, queries }] of Object.entries(SEARCHES) as [
    MeasurementLanguage,
    { country: string; queries: string[] },
  ][]) {
    for (const query of queries) {
      const hits = await searchText(
        {
          textQuery: query,
          mask: "target",
          languageCode: language,
          regionCode: country.toLowerCase(),
        },
        spend,
      );
      const kept = hits
        .filter((hit) => hit.businessStatus === "OPERATIONAL")
        .map((hit) => ({ hit, expected: expectedOf(hit) }))
        .filter(({ hit, expected }) => {
          const component = hit.addressComponents?.find((c) => c.types.includes("country"));
          return expected !== null && component?.shortText.toUpperCase() === country;
        })
        .slice(0, PER_SEARCH);
      for (const { hit, expected } of kept) {
        businesses.push({
          language,
          country,
          query,
          placeId: hit.id,
          displayName: hit.displayName,
          types: hit.types,
          primaryType: hit.primaryType,
          primaryTypeDisplayName: hit.primaryTypeDisplayName ?? null,
          googleMapsTypeLabel: hit.googleMapsTypeLabel ?? null,
          pureServiceAreaBusiness: hit.pureServiceAreaBusiness ?? false,
          expected,
        });
      }
      summary.push(`| ${language} | ${query} | ${kept.length} |`);
    }
    const count = businesses.filter((b) => b.language === language).length;
    if (count !== PER_LANGUAGE) short.push(`${language}: ${count} of ${PER_LANGUAGE}`);
  }
  writeFileSync(
    file,
    `${JSON.stringify({ recordedAt: new Date().toISOString(), businesses }, null, 2)}\n`,
  );
  closeSync(file);
  const table = `${summary.join("\n")}\n`;
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  for (const line of short) console.error(`Too few businesses: ${line}`);
  return short.length === 0;
}

const out = process.argv[2];
if (!out) throw new Error("Usage: record-categories.ts <output file>");
try {
  process.exitCode = (await main(resolve(out))) ? 0 : 1;
} finally {
  await endPools();
}
