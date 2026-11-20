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
});
