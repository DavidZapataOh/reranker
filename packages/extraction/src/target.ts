import { getGeo, resolveGeo } from "@reranker/catalog";
import { type CountryCode, isMeasurable } from "@reranker/i18n/countries";
import { InvalidInputError, type SpendContext } from "@reranker/jobs";
import type { BusinessCandidate, BusinessCategory, GeoTarget } from "@reranker/schema/measurement";
import { Parser } from "htmlparser2";
import { parse } from "tldts";
import { categoryByRules } from "./category";
import { currentExtractorConfig } from "./config";
import { jaroWinkler, normalizeName } from "./normalize";
import { type PlaceHit, searchText } from "./places/client";
import { scoreCandidates } from "./places/score";
import { safeGet } from "./web/safe-get";

const MAX_CANDIDATES = 5;
const PAGE_MAX_BYTES = 524_288;
// Below this a Places hit is another business that shares words with the domain.
const DOMAIN_NAME_MATCH = 0.9;
// Google treats these ccTLDs as generic (Search Central, "Managing multi-regional sites"), so they
// say nothing about where a business is. `.co` stays a Colombian signal: Colombia is our home
// market, and its owners register `.co` far more than anyone else among our customers.
const GENERIC_CCTLDS = new Set([
  "ad",
  "ai",
  "as",
  "bz",
  "cc",
  "cd",
  "dj",
  "fm",
  "io",
  "la",
  "me",
  "ms",
  "nu",
  "sc",
  "sr",
  "su",
  "tv",
  "tk",
  "ws",
]);
// The only ccTLD that differs from its ISO 3166-1 code.
const CCTLD_COUNTRY: Record<string, string> = { uk: "GB" };

interface TypedDomain {
  hostname: string;
  tld: string;
  /** The registrable name without its suffix, as a business would be called. */
  name: string;
}

function domainOf(query: string): TypedDomain | null {
  const text = query.trim().toLowerCase();
  if (text === "" || /\s/.test(text)) return null;
  const parsed = parse(text, { allowPrivateDomains: true });
  // A suffix outside the Public Suffix List ("pan.de.yuca") is text that happens to have dots.
  if (!parsed.hostname || !parsed.domainWithoutSuffix) return null;
  if (!parsed.isIcann && !parsed.isPrivate) return null;
  const hostname = parsed.hostname.replace(/^www\./, "");
  return {
    hostname,
    tld: hostname.slice(hostname.lastIndexOf(".") + 1),
    name: parsed.domainWithoutSuffix.replace(/[-_.]+/g, " ").trim(),
  };
}

function countryOfTld(tld: string): CountryCode | null {
  if (GENERIC_CCTLDS.has(tld)) return null;
  const code = CCTLD_COUNTRY[tld] ?? tld.toUpperCase();
  return code.length === 2 && isMeasurable(code) ? code : null;
}

function countryOfLang(lang: string | null): CountryCode | null {
  if (!lang) return null;
  try {
    const region = new Intl.Locale(lang.trim().replace(/_/g, "-")).region;
    return region !== undefined && isMeasurable(region) ? region : null;
  } catch {
    return null;
  }
}

interface PageHead {
  lang: string | null;
  title: string | null;
  siteName: string | null;
  description: string | null;
}

function readHead(html: string): PageHead {
  const head: PageHead = { lang: null, title: null, siteName: null, description: null };
  let inTitle = false;
  let title = "";
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "html") head.lang ??= attrs.lang ?? null;
        if (name === "title" && head.title === null) inTitle = true;
        if (name !== "meta" || attrs.content === undefined) return;
        if (attrs.property === "og:site_name") head.siteName ??= attrs.content.trim() || null;
        if (attrs.name?.toLowerCase() === "description") {
          head.description ??= attrs.content.trim() || null;
        }
      },
      ontext(text) {
        if (inTitle) title += text;
      },
      onclosetag(name) {
        if (name !== "title" || !inTitle) return;
        inTitle = false;
        head.title = title.replace(/\s+/g, " ").trim() || null;
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  return head;
}

async function websiteCandidate(domain: TypedDomain): Promise<BusinessCandidate | null> {
  const page = await safeGet(`https://${domain.hostname}/`, {
    timeoutMs: currentExtractorConfig.timeoutsMs.website,
    maxBytes: PAGE_MAX_BYTES,
  });
  if (page?.status !== 200) return null;
  const head = readHead(page.body);
  const country = countryOfTld(domain.tld) ?? countryOfLang(head.lang);
  return {
    kind: "website",
    placeId: null,
    domain: domain.hostname,
    displayName: head.siteName ?? head.title ?? domain.hostname,
    formattedAddress: null,
    geo: country === null ? null : nationalGeo(country),
    neighborhood: null,
    categoryHint: null,
    // The owner typed this exact domain and it answered.
    confidence: 1,
    attribution: null,
    website: { title: head.title, siteName: head.siteName, description: head.description },
  };
}

function nationalGeo(country: CountryCode): GeoTarget {
  return getGeo(country.toLowerCase());
}

function placeCandidate(hit: PlaceHit, confidence: number): BusinessCandidate | null {
  const components = hit.addressComponents ?? [];
  const component = (type: string) => components.find((c) => c.types.includes(type));
  const country = component("country")?.shortText.toUpperCase();
  if (country === undefined || !isMeasurable(country)) return null;
  const candidate: BusinessCandidate = {
    kind: "place",
    placeId: hit.id,
    domain: null,
    displayName: hit.displayName,
    formattedAddress: hit.formattedAddress,
    geo: resolveGeo({
      country,
      addressComponents: components,
      ...(hit.location && {
        location: { lat: hit.location.latitude, lng: hit.location.longitude },
      }),
    }),
    neighborhood: (component("sublocality_level_1") ?? component("neighborhood"))?.longText ?? null,
    categoryHint: null,
    confidence,
    attribution: "Google Maps",
    places: {
      types: hit.types,
      primaryType: hit.primaryType,
      primaryTypeDisplayName: hit.primaryTypeDisplayName ?? null,
      googleMapsTypeLabel: hit.googleMapsTypeLabel ?? null,
      pureServiceAreaBusiness: hit.pureServiceAreaBusiness ?? false,
    },
  };
  return { ...candidate, categoryHint: hintOf(candidate) };
}

/** What Places already tells about the category, as a plain category the candidate can carry. */
function hintOf(candidate: BusinessCandidate): BusinessCategory | null {
  const rules = categoryByRules(candidate);
  if (rules === null) return null;
  const { confidence: _, language: __, nounGender: ___, ...hint } = rules;
  return hint;
}

/**
 * The businesses an owner may mean by what they typed, in measurable countries only, best first.
 * `country` is where the request comes from: it only biases the search, never places the business.
 * Nothing is stored.
 */
export async function findBusinessCandidates(q: {
  query: string;
  country: CountryCode | null;
  spend: SpendContext;
}): Promise<BusinessCandidate[]> {
  const domain = domainOf(q.query);
  const textQuery = domain?.name || q.query.trim();
  if (textQuery === "") throw new InvalidInputError("empty business query");

  const hits = await searchText(
    {
      textQuery,
      mask: "target",
      includePureServiceAreaBusinesses: true,
      // Without a measurable country Places falls back to IP bias; the contract test keeps that
      // within 5 points of hits found with the right region code.
      ...(q.country !== null && { regionCode: q.country.toLowerCase() }),
    },
    q.spend,
  );
  // What the owner types is looked up as a business; its candidates must fold the same way.
  const kind = "business";
  const nameNorm = normalizeName(textQuery, kind);
  const places = scoreCandidates(
    { nameNorm, kind, locationHint: null, citedDomains: [] },
    hits,
    { categoryTypes: [], websites: new Map() },
    currentExtractorConfig.resolution,
  )
    .map(({ hit, score }) => placeCandidate(hit, score))
    .filter((candidate) => candidate !== null);

  const found =
    domain !== null &&
    hits.some(
      (hit) => jaroWinkler(nameNorm, normalizeName(hit.displayName, kind)) >= DOMAIN_NAME_MATCH,
    );
  const website = domain === null || found ? null : await websiteCandidate(domain);
  return (website ? [website, ...places] : places).slice(0, MAX_CANDIDATES);
}

/** The national target of the country the owner chose for a website without a country signal. */
export function assignCountry(
  candidate: BusinessCandidate,
  country: CountryCode,
): BusinessCandidate {
  if (!isMeasurable(country)) throw new InvalidInputError(`country ${country} is not measurable`);
  return { ...candidate, geo: nationalGeo(country) };
}
