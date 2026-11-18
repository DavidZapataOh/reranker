import { requiredIn, secret } from "@reranker/env";
import { z } from "@reranker/schema";

// Preview calls the free sandbox with the same account; it joins the required environments once
// Vercel Preview holds the credentials.
export const captureEnv = z.object({
  DATAFORSEO_LOGIN: requiredIn(["production"], secret(z.string().min(1), "DataForSEO API login")),
  DATAFORSEO_PASSWORD: requiredIn(
    ["production"],
    secret(z.string().min(1), "DataForSEO API password"),
  ),
});
