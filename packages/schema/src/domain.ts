import { ENGINES } from "@reranker/i18n";
import { z } from "./z";

export const CaptureChannel = z.enum(["ui-vendor", "ui-own", "api"]);
export type CaptureChannel = z.infer<typeof CaptureChannel>;

// Providers with a capture kill switch: DataForSEO and Bright Data serve `ui-vendor`, OpenAI serves `api`.
export const CaptureProvider = z.enum(["dataforseo", "brightdata", "openai"]);
export type CaptureProvider = z.infer<typeof CaptureProvider>;

export const EngineId = z.enum(ENGINES);
export type EngineId = z.infer<typeof EngineId>;

export const AppEnv = z.enum(["development", "preview", "production"]);
export type AppEnv = z.infer<typeof AppEnv>;
