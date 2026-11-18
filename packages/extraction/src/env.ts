import { secret } from "@reranker/env";
import { z } from "@reranker/schema";

const HMAC_KEY_BYTES = 32;

export const extractionEnv = z.object({
  OPENAI_API_KEY: secret(
    z.string().startsWith("sk-"),
    "OpenAI API key for the extractors and judges",
  ),
  GEMINI_API_KEY: secret(z.string().min(1), "Gemini API key for the secondary extractor"),
  // Only needed once a Claude model wins an extraction role.
  ANTHROPIC_API_KEY: secret(
    z.string().startsWith("sk-ant-").optional(),
    "Anthropic API key, set only when a Claude model holds an extraction role",
  ),
  GOOGLE_PLACES_API_KEY: secret(z.string().min(1), "Google Places API (New) key for resolution"),
  ENTITY_NAME_HMAC_KEY: secret(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, "must be base64url without padding")
      .refine((value) => Buffer.from(value, "base64url").length >= HMAC_KEY_BYTES, {
        message: `must decode to at least ${HMAC_KEY_BYTES} bytes`,
      }),
    "HMAC key for professional names in the public panel, at least 32 bytes base64url",
  ),
});
