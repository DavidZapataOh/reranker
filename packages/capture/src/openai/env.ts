import { requiredIn, secret } from "@reranker/env";
import { z } from "@reranker/schema";

// Its own OpenAI project, whose budget caps the control channel apart from extraction. Only
// production captures through it; the contract test passes the CI key explicitly.
export const openaiControlEnv = z.object({
  OPENAI_CONTROL_API_KEY: requiredIn(
    ["production"],
    secret(z.string().startsWith("sk-"), "OpenAI API key for the control channel"),
  ),
});
