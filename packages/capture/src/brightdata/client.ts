import { defineEnv } from "@reranker/env";
import type { RawSink } from "../raw/raw-sink";
import { type Fetch, recordingFetch } from "../raw/tee-fetch";
import { brightdataEnv } from "./env";

export const BRIGHTDATA_API = "https://api.brightdata.com";

export type BrightDataDataset = "perplexity" | "chatgpt";

// The synchronous scrape holds the connection for up to a minute before answering 202.
const SCRAPE_TIMEOUT_MS = 75_000;
const MONITOR_TIMEOUT_MS = 30_000;

export interface BrightDataClient {
  datasetId(d: BrightDataDataset): string;
  /** Sends the scrape and keeps its exact request and response bytes in the sink. */
  fetch: Fetch;
  /**
   * Progress polls and snapshot downloads. They are not recorded, so the sink keeps the scrape
   * request they answer; `deliver` records the bytes that become the response.
   */
  monitor: Fetch;
  /** Records a later answer to the recorded scrape, such as its snapshot download. */
  deliver(response: Response, body: Uint8Array): void;
}

/** Bright Data's Scraper API with Bearer authentication, as its REST reference sends it. */
export function createBrightData(sink: RawSink, opts: { apiKey?: string } = {}): BrightDataClient {
  const env = defineEnv([brightdataEnv]);
  const apiKey = opts.apiKey ?? env.BRIGHTDATA_API_KEY;
  if (!apiKey) throw new Error("Bright Data API key missing: set BRIGHTDATA_API_KEY");
  const headers = { Authorization: `Bearer ${apiKey}` };
  const datasets: Record<BrightDataDataset, string> = {
    perplexity: env.BRIGHTDATA_PERPLEXITY_DATASET_ID,
    chatgpt: env.BRIGHTDATA_CHATGPT_DATASET_ID,
  };

  return {
    datasetId: (d) => datasets[d],
    fetch: recordingFetch(sink, { headers, timeoutMs: SCRAPE_TIMEOUT_MS }),
    monitor: (url, init) => {
      const merged = new Headers(init?.headers);
      merged.set("Authorization", headers.Authorization);
      const timeout = AbortSignal.timeout(MONITOR_TIMEOUT_MS);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      return fetch(url, { ...init, headers: merged, signal });
    },
    deliver: (response, body) => {
      sink.recordResponseHead(response);
      sink.recordResponseBody(body);
    },
  };
}
