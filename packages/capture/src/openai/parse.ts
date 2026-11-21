import { z } from "@reranker/schema";
import type { EngineAnswer } from "../answer";

export const OPENAI_RESPONSES_PARSER = { name: "openai-responses@1", version: 1 } as const;

type Source = EngineAnswer["sources"][number];

// Only the fields the parser reads; anything OpenAI adds never breaks the parse.
const Citation = z.looseObject({
  type: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
});
const Item = z.looseObject({
  type: z.string(),
  action: z
    .looseObject({
      type: z.string(),
      queries: z.array(z.string()).optional(),
      sources: z.array(z.looseObject({ type: z.string(), url: z.string().optional() })).optional(),
    })
    .optional(),
  content: z
    .array(
      z.looseObject({
        type: z.string(),
        text: z.string().optional(),
        annotations: z.array(Citation).optional(),
      }),
    )
    .optional(),
});
const ResponseBody = z.looseObject({
  id: z.string().min(1),
  object: z.literal("response"),
  model: z.string(),
  output: z.array(Item),
});

const asUrl = (url: string) => (URL.canParse(url) ? new URL(url) : null);

// OpenAI tags every cited link with utm_source=openai; the searched source carries no tag.
function untagged(url: string): string {
  const parsed = asUrl(url);
  if (parsed?.searchParams.get("utm_source") !== "openai") return url;
  parsed.searchParams.delete("utm_source");
  return parsed.toString();
}

const sameUrlKey = (url: string) => asUrl(untagged(url))?.toString() ?? url;
const hostname = (url: string) => asUrl(url)?.hostname ?? "";

function header(headers: Headers, name: string): string | undefined {
  return headers.get(name)?.trim() || undefined;
}

function processingMs(headers: Headers): number | undefined {
  const value = header(headers, "openai-processing-ms");
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

/**
 * One Responses API answer of the control channel. Sources are what the searches returned, in
 * order, marked cited when the answer links them; cited links no search listed come after.
 */
export function parseOpenAIResponse(
  bytes: Uint8Array,
  headers: Headers,
  requestedModel: string,
): EngineAnswer {
  const body = ResponseBody.parse(JSON.parse(new TextDecoder().decode(bytes)));
  const searches = body.output.filter(
    (item) => item.type === "web_search_call" && item.action?.type === "search",
  );
  const parts = body.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text");
  // Joined the way the SDK's output_text joins them.
  const markdown = parts.map((part) => part.text ?? "").join("");
  const citations = parts
    .flatMap((part) => part.annotations ?? [])
    .filter((a): a is typeof a & { url: string } => a.type === "url_citation" && !!a.url);

  const cited = new Map(citations.map((c) => [sameUrlKey(c.url), c]));
  const sources = new Map<string, Source>();
  const add = (url: string, title: string | undefined) => {
    const key = sameUrlKey(url);
    if (sources.has(key)) return;
    const citation = cited.get(key);
    const name = citation?.title || title;
    sources.set(key, {
      url,
      domain: hostname(url),
      ...(name ? { title: name } : {}),
      cited: citation !== undefined,
    });
  };
  for (const search of searches) {
    for (const source of search.action?.sources ?? []) if (source.url) add(source.url, undefined);
  }
  for (const citation of citations) add(untagged(citation.url), citation.title);

  // `queries` replaces the deprecated single `query`, which only repeats the first of them.
  const queries = [...new Set(searches.flatMap((search) => search.action?.queries ?? []))].filter(
    (q) => q !== "",
  );
  const requestId = header(headers, "x-request-id");
  const ms = processingMs(headers);

  return {
    parserVersion: OPENAI_RESPONSES_PARSER.name,
    engine: "chatgpt",
    channel: "api",
    provider: "openai",
    modelReported: body.model || null,
    present: markdown.trim() !== "",
    markdown,
    sources: [...sources.values()],
    searchQueries: queries,
    meta: {
      ...(requestId ? { requestId } : {}),
      ...(ms !== undefined ? { processingMs: ms } : {}),
      responseId: body.id,
      searches: searches.length,
      modelRequested: requestedModel,
    },
  };
}
