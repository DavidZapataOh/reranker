import { secret } from "@reranker/env";
import { z } from "@reranker/schema";

export const catalogEnv = z.object({
  OPENAI_API_KEY: secret(
    z.string().startsWith("sk-"),
    "OpenAI API key for intent paraphrases, embeddings and the judge",
  ),
  GEMINI_API_KEY: secret(z.string().min(1), "Gemini API key for intent paraphrases"),
});
