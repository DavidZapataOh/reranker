import { requiredIn, secret } from "@reranker/env";
import { z } from "@reranker/schema";

// Preview captures against the free sandbox with the same account, so it needs them too.
export const captureEnv = z.object({
  DATAFORSEO_LOGIN: requiredIn(
    ["preview", "production"],
    secret(z.string().min(1), "DataForSEO API login"),
  ),
  DATAFORSEO_PASSWORD: requiredIn(
    ["preview", "production"],
    secret(z.string().min(1), "DataForSEO API password"),
  ),
  // Its own OpenAI project, whose budget caps the control channel apart from extraction.
  OPENAI_CONTROL_API_KEY: requiredIn(
    ["production"],
    secret(z.string().startsWith("sk-"), "OpenAI API key for the control channel"),
  ),
});
