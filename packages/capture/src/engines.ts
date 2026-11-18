import {
  type CaptureChannel,
  type CaptureProvider,
  cost,
  type EngineId,
  type ProviderCost,
} from "@reranker/schema";

export interface EngineSpec {
  engine: EngineId;
  provider: CaptureProvider;
  /** Provider that takes over when `provider` is switched off or out of capacity. */
  fallback?: CaptureProvider;
  channel: CaptureChannel;
  /** What a call reserves before it runs; the provider's reported cost settles it. */
  estimate: { live: ProviderCost; task?: ProviderCost };
  geoSupport: "city" | "coordinate" | "country";
  /** Orders dispatch slowest first and decides whether a retry still fits before the deadline. */
  p50LatencyMs: number;
}

// DataForSEO list prices: Live US$0.004 per call on every endpoint used (AI Overview is Organic
// US$0.002 plus load_async_ai_overview US$0.002), Standard queue US$0.0012.
const DATAFORSEO_ESTIMATE = { live: cost(4_000, "USD"), task: cost(1_200, "USD") };

// Latencies are the ones the providers document until measured captures replace them.
export const ENGINES: Record<EngineId, EngineSpec> = {
  chatgpt: {
    engine: "chatgpt",
    provider: "dataforseo",
    channel: "ui-vendor",
    estimate: DATAFORSEO_ESTIMATE,
    geoSupport: "country",
    p50LatencyMs: 20_000,
  },
  gemini: {
    engine: "gemini",
    provider: "dataforseo",
    channel: "ui-vendor",
    estimate: DATAFORSEO_ESTIMATE,
    geoSupport: "coordinate",
    p50LatencyMs: 27_000,
  },
  "google-ai-overview": {
    engine: "google-ai-overview",
    provider: "dataforseo",
    channel: "ui-vendor",
    estimate: DATAFORSEO_ESTIMATE,
    geoSupport: "city",
    p50LatencyMs: 12_000,
  },
  perplexity: {
    engine: "perplexity",
    provider: "brightdata",
    channel: "ui-vendor",
    estimate: { live: cost(1_500, "USD") },
    geoSupport: "country",
    // Bright Data publishes no latency; its synchronous scrape answers within a minute or hands
    // back a snapshot, so the bound keeps a retry from being scheduled where it cannot finish.
    p50LatencyMs: 60_000,
  },
};
