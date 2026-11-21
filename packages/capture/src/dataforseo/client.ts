import { appEnv, defineEnv } from "@reranker/env";
import { AiOptimizationApi, DataforseoLabsApi, KeywordsDataApi, SerpApi } from "dataforseo-client";
import { captureEnv } from "../env";
import type { RawSink } from "../raw/raw-sink";
import { type Fetch, teeFetch } from "../raw/tee-fetch";

// The sandbox serves every endpoint for free with the same account
// (https://docs.dataforseo.com/v3/appendix/sandbox/), so only production spends.
const BASE_URLS = {
  sandbox: "https://sandbox.dataforseo.com",
  production: "https://api.dataforseo.com",
} as const;

/** The official clients over a fetch that records every call's exact bytes in `sink`. */
export function createDataForSeo(
  sink: RawSink,
  opts: { base?: keyof typeof BASE_URLS; timeoutMs?: number } = {},
): {
  ai: AiOptimizationApi;
  keywords: KeywordsDataApi;
  labs: DataforseoLabsApi;
  serp: SerpApi;
  /** The same recording fetch and base, for documented endpoints the client does not wrap. */
  http: { base: string; fetch: Fetch };
} {
  const env = defineEnv([captureEnv]);
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) {
    throw new Error("DataForSEO credentials missing: set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD");
  }
  const base = BASE_URLS[opts.base ?? (appEnv() === "production" ? "production" : "sandbox")];
  const http = {
    fetch: teeFetch(
      { login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD },
      sink,
      opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs },
    ),
  };
  return {
    ai: new AiOptimizationApi(base, http),
    keywords: new KeywordsDataApi(base, http),
    labs: new DataforseoLabsApi(base, http),
    serp: new SerpApi(base, http),
    http: { base, fetch: http.fetch },
  };
}
