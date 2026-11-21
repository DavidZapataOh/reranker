import { config, requiredIn, secret } from "@reranker/env";
import { z } from "@reranker/schema";

// Its own OpenAI project, whose budget caps the control channel apart from extraction. Only
// production captures through it; the contract test passes the CI key explicitly.
export const openaiControlEnv = z.object({
  OPENAI_CONTROL_API_KEY: requiredIn(
    ["production"],
    secret(z.string().startsWith("sk-"), "OpenAI API key for the control channel"),
  ),
  // Defaults to the model the control profile pins; any other value fails the profile check.
  OPENAI_CONTROL_MODEL: config(
    z.string().min(1).default("gpt-6.1-terra"),
    "OpenAI model the control channel asks, pinned by its profile",
  ),
});
