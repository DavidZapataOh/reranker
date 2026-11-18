import { CaptureChannel, CaptureProvider, EngineId, z } from "@reranker/schema";

const Source = z.strictObject({
  url: z.string().min(1),
  domain: z.string(),
  title: z.string().optional(),
  cited: z.boolean(),
  // Gemini grounding redirects resolved at ingestion; `url` stays as returned.
  resolvedUrl: z.string().min(1).optional(),
});

// Normalized answer of one capture, derived from the raw bytes and re-derivable from them.
export const EngineAnswer = z.strictObject({
  parserVersion: z.string().regex(/^[a-z0-9-]+@[1-9]\d*$/, "must be <parser>@<version>"),
  engine: EngineId,
  channel: CaptureChannel,
  provider: CaptureProvider,
  modelReported: z.string().min(1).nullable(),
  // False when the surface did not show, such as a results page without an AI Overview.
  present: z.boolean(),
  markdown: z.string(),
  sources: z.array(Source),
  // Only queries the engine reported; a parser never fills this with the prompt.
  searchQueries: z.union([z.array(z.string().min(1)), z.literal("unavailable")]),
  localBusinesses: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        url: z.string().optional(),
        address: z.string().optional(),
        rating: z.number().optional(),
      }),
    )
    .optional(),
  brandEntities: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        category: z.string().optional(),
        urls: z.array(z.string()),
      }),
    )
    .optional(),
  // Kept as returned so a later reader needs no reparse.
  products: z.array(z.unknown()).optional(),
  meta: z
    .strictObject({
      requestId: z.string().optional(),
      processingMs: z.int().nonnegative().optional(),
      responseId: z.string().optional(),
      searches: z.int().nonnegative().optional(),
      modelRequested: z.string().optional(),
    })
    .optional(),
});
export type EngineAnswer = z.infer<typeof EngineAnswer>;

/** Parser versions by parser name; the number is stored with each capture and its seal. */
export const PARSER_VERSIONS: Record<string, number> = {
  chatgpt: 1,
  gemini: 1,
  "google-ai-overview": 1,
  "google-ai-mode": 1,
};

/** Never throws: a body that does not parse is still sealed, with the error beside it. */
export function safeParseAnswer(
  parse: (bytes: Uint8Array) => EngineAnswer,
  bytes: Uint8Array,
): { answer: EngineAnswer | null; error: string | null } {
  let candidate: unknown;
  try {
    candidate = parse(bytes);
  } catch (error) {
    return {
      answer: null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
  const result = EngineAnswer.safeParse(candidate);
  return result.success
    ? { answer: result.data, error: null }
    : { answer: null, error: z.prettifyError(result.error) };
}
