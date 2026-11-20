import { z } from "@reranker/schema";
import type { EngineAnswer } from "../../answer";

export const CHATGPT_BRIGHTDATA_PARSER = { name: "chatgpt-brightdata@1", version: 1 } as const;

type Source = EngineAnswer["sources"][number];
type LocalBusiness = NonNullable<EngineAnswer["localBusinesses"]>[number];

// The scraper sends every output field and nulls the ones an answer lacks.
const maybe = <T extends z.ZodType>(schema: T) => schema.nullish();
const links = maybe(z.array(z.looseObject({ url: maybe(z.string()), title: maybe(z.string()) })));
const place = z.looseObject({
  name: maybe(z.string()),
  website_url: maybe(z.string()),
  address: maybe(z.string()),
  rating: maybe(z.number()),
});

// Only the fields the parser reads; a field Bright Data adds never breaks the parse.
export const ChatGptRecord = z.looseObject({
  answer_text: maybe(z.string()),
  answer_text_markdown: maybe(z.string()),
  model: maybe(z.string()),
  web_search_query: maybe(z.array(z.string())),
  citations: links,
  links_attached: links,
  search_sources: links,
  search_sources_more: links,
  business_locations: maybe(z.array(place)),
  map: maybe(z.array(place)),
  shopping: maybe(z.array(z.unknown())),
  shopping_visible: maybe(z.boolean()),
});

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

const text = (value: string | null | undefined) => (value ? value : undefined);

type Link = { url?: string | null | undefined; title?: string | null | undefined };

/** One source per URL in answer order: what the answer cites, then what it only retrieved. */
function sourcesOf(cited: Link[], retrieved: Link[]): Source[] {
  const out = new Map<string, Source>();
  const add = (link: Link, isCited: boolean) => {
    const url = text(link.url);
    if (url === undefined || out.has(url)) return;
    const title = text(link.title);
    // `domain` arrives as an origin URL, so the hostname is taken from the link itself.
    out.set(url, { url, domain: hostname(url), ...(title ? { title } : {}), cited: isCited });
  };
  for (const link of cited) add(link, true);
  for (const link of retrieved) add(link, false);
  return [...out.values()];
}

/** The map card's businesses, the richer `business_locations` first, one per name. */
function localBusinessesOf(places: z.infer<typeof place>[]): LocalBusiness[] {
  const out = new Map<string, LocalBusiness>();
  for (const p of places) {
    const name = text(p.name);
    if (name === undefined || out.has(name)) continue;
    const url = text(p.website_url);
    const address = text(p.address);
    out.set(name, {
      name,
      ...(url ? { url } : {}),
      ...(address ? { address } : {}),
      ...(typeof p.rating === "number" && Number.isFinite(p.rating) ? { rating: p.rating } : {}),
    });
  }
  return [...out.values()];
}

/** One record of Bright Data's ChatGPT Search scraper (`gd_m7aof0k82r803d5bjm`). */
export function parseChatGpt(record: unknown): EngineAnswer {
  const r = ChatGptRecord.parse(record);
  const markdown = r.answer_text_markdown ?? r.answer_text ?? "";
  const queries = (r.web_search_query ?? []).filter((q) => q !== "");
  return {
    parserVersion: CHATGPT_BRIGHTDATA_PARSER.name,
    engine: "chatgpt",
    channel: "ui-vendor",
    provider: "brightdata",
    modelReported: text(r.model) ?? null,
    present: markdown.trim() !== "",
    markdown,
    sources: sourcesOf(
      [...(r.citations ?? []), ...(r.links_attached ?? [])],
      [...(r.search_sources ?? []), ...(r.search_sources_more ?? [])],
    ),
    searchQueries: queries.length > 0 ? queries : "unavailable",
    localBusinesses: localBusinessesOf([...(r.business_locations ?? []), ...(r.map ?? [])]),
    products: r.shopping_visible === true ? (r.shopping ?? []) : [],
  };
}
