import type { EngineAnswer } from "../../answer";
import { field, firstResult, list, sources, text } from "./wire";

type GoogleEngine = "google-ai-overview" | "google-ai-mode";
type LocalBusiness = NonNullable<EngineAnswer["localBusinesses"]>[number];

// AI Mode cites the places it recommends with their Google place card, not with a web page.
const PLACE_CARD = "https://www.google.com/searchviewer/";

const isPlaceCard = (entry: unknown) => text(field(entry, "url"))?.startsWith(PLACE_CARD) ?? false;

// AI Overviews cite products with their Google Shopping card (`prds=` names the product).
function isProductCard(entry: unknown): boolean {
  const url = text(field(entry, "url"));
  if (url === undefined || !url.startsWith("https://www.google.com/search?")) return false;
  return new URL(url).searchParams.has("prds");
}

/** One entry per URL, the first seen. */
function byUrl(entries: unknown[]): unknown[] {
  const out = new Map<string, unknown>();
  for (const entry of entries) {
    const url = text(field(entry, "url"));
    if (url !== undefined && !out.has(url)) out.set(url, entry);
  }
  return [...out.values()];
}

// Every place a citation may sit, in reading order: the overview's own references, then each
// element's references and inline links, then those of an expanded element's components.
function citations(overview: unknown): unknown[] {
  const elements = list(field(overview, "items"));
  const components = elements.flatMap((e) => list(field(e, "components")));
  return [overview, ...elements, ...components].flatMap((node) => [
    ...list(field(node, "references")),
    ...list(field(node, "links")),
  ]);
}

function placeCard(entry: unknown): LocalBusiness[] {
  const name = text(field(entry, "title"));
  const url = text(field(entry, "url"));
  return name === undefined ? [] : [{ name, ...(url === undefined ? {} : { url }) }];
}

/**
 * The answer an `ai_overview` item holds, the same schema in Organic and in AI Mode; without the
 * item the surface did not show, which is an answer too.
 */
export function overviewAnswer(
  items: unknown[],
  engine: GoogleEngine,
  parserVersion: string,
): EngineAnswer {
  const overview = items.find((item) => field(item, "type") === "ai_overview");
  const base = {
    parserVersion,
    engine,
    channel: "ui-vendor",
    provider: "dataforseo",
    // Google reports neither the model nor the searches behind the answer.
    modelReported: null,
    searchQueries: "unavailable",
  } as const;
  if (overview === undefined) return { ...base, present: false, markdown: "", sources: [] };
  const cited = citations(overview);
  const shopping = list(field(overview, "items"))
    .filter((e) => field(e, "type") === "ai_overview_shopping")
    .flatMap((e) => list(field(e, "items")));
  return {
    ...base,
    present: true,
    markdown: text(field(overview, "markdown")) ?? "",
    // Place and product cards are no web pages: as sources they would credit google.com.
    sources: sources(cited.filter((e) => !isPlaceCard(e) && !isProductCard(e))),
    localBusinesses: byUrl(cited.filter(isPlaceCard)).flatMap(placeCard),
    products: [...shopping, ...byUrl(cited.filter(isProductCard))],
  };
}

/** Google's AI Overview from DataForSEO's Organic SERP, Live or task_get/advanced. */
export function parseAiOverview(bytes: Uint8Array): EngineAnswer {
  const result = firstResult<{ items?: unknown }>(bytes);
  return overviewAnswer(list(result.items), "google-ai-overview", "ai-overview@1");
}
