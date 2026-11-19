import { config, requiredIn, secret } from "@reranker/env";
import { z } from "@reranker/schema";

const datasetId = (fallback: string, description: string) =>
  config(
    z
      .string()
      .regex(/^gd_[a-z0-9]+$/)
      .default(fallback),
    description,
  );

// Only production captures through Bright Data; the CI copies of the keys are passed explicitly.
// The dataset ids are Bright Data's published scraper ids, overridable when it ships a new one.
export const brightdataEnv = z.object({
  BRIGHTDATA_API_KEY: requiredIn(
    ["production"],
    secret(z.string().min(1), "Bright Data API key with User permission, for the scrapers"),
  ),
  BRIGHTDATA_PERPLEXITY_DATASET_ID: datasetId(
    "gd_m7dhdot1vw9a7gc1n",
    "Bright Data Perplexity scraper dataset id",
  ),
  BRIGHTDATA_CHATGPT_DATASET_ID: datasetId(
    "gd_m7aof0k82r803d5bjm",
    "Bright Data ChatGPT Search scraper dataset id",
  ),
  BRIGHTDATA_BILLING_API_KEY: requiredIn(
    ["production"],
    secret(z.string().min(1), "Bright Data API key with Finance permission, for the free tier"),
  ),
});
