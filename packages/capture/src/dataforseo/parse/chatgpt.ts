import type { IAiOptimizationChatGptLlmScraperLiveAdvancedResultInfo } from "dataforseo-client";
import type { EngineAnswer } from "../../answer";
import { field, firstResult, list, queries, sources, text } from "./wire";

type LocalBusiness = NonNullable<EngineAnswer["localBusinesses"]>[number];
type BrandEntity = NonNullable<EngineAnswer["brandEntities"]>[number];

const elementsOf = (items: unknown[], type: string): unknown[] =>
  items
    .filter((item) => field(item, "type") === type)
    .flatMap((item) => list(field(item, "items")));

function localBusiness(element: unknown): LocalBusiness | null {
  const name = text(field(element, "title"));
  if (name === undefined) return null;
  const url = text(field(element, "url"));
  const address = text(field(element, "address"));
  const rating = field(field(element, "rating"), "value");
  return {
    name,
    ...(url === undefined ? {} : { url }),
    ...(address === undefined ? {} : { address }),
    ...(typeof rating === "number" && Number.isFinite(rating) ? { rating } : {}),
  };
}

function brandEntity(entity: unknown): BrandEntity | null {
  // Recorded answers carry the entity's name in `markdown` and its disambiguation in `title`.
  const name = text(field(entity, "markdown")) ?? text(field(entity, "title"));
  if (name === undefined) return null;
  const category = text(field(entity, "category"));
  return {
    name,
    ...(category === undefined ? {} : { category }),
    urls: list(field(entity, "urls")).flatMap((u) => text(field(u, "url")) ?? []),
  };
}

const present = <T>(value: T | null): value is T => value !== null;

/** ChatGPT answer from DataForSEO's LLM Scraper, Live or task_get/advanced. */
export function parseChatGpt(bytes: Uint8Array): EngineAnswer {
  const result = firstResult<IAiOptimizationChatGptLlmScraperLiveAdvancedResultInfo>(bytes);
  const items = list(result.items);
  const inline = items.flatMap((item) => list(field(item, "sources")));
  return {
    parserVersion: "chatgpt@1",
    engine: "chatgpt",
    channel: "ui-vendor",
    provider: "dataforseo",
    modelReported: text(result.model) ?? null,
    present: true,
    markdown: text(result.markdown) ?? "",
    // `search_results` holds every page the model looked up, cited or not.
    sources: sources([...list(result.sources), ...inline], list(result.search_results)),
    searchQueries: queries(result.fan_out_queries),
    localBusinesses: elementsOf(items, "chat_gpt_local_businesses")
      .map(localBusiness)
      .filter(present),
    brandEntities: list(result.brand_entities).map(brandEntity).filter(present),
    products: elementsOf(items, "chat_gpt_products"),
  };
}
