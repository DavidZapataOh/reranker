import { ENGINES } from "@reranker/i18n";
import { expect, test } from "vitest";
import { AppEnv, CaptureChannel, CaptureProvider, EngineId } from "../src/domain";
import { CountryCode, CurrencyCode, LocaleCode } from "../src/primitives";

test("domain ids", () => {
  expect(EngineId.options).toEqual(["chatgpt", "gemini", "google-ai-overview", "perplexity"]);
  expect(EngineId.options).toEqual([...ENGINES]);
  expect(CaptureChannel.options).toEqual(["ui-vendor", "ui-own", "api"]);
  expect(CaptureProvider.options).toEqual(["dataforseo", "brightdata", "openai"]);
  expect(AppEnv.safeParse("staging").success).toBe(false);
  expect(AppEnv.options).toEqual(["development", "preview", "production"]);
});

test("registry-backed codes", () => {
  expect(CountryCode.safeParse("CO").success).toBe(true);
  expect(CountryCode.safeParse("XX").success).toBe(false);
  expect(CurrencyCode.options).toEqual(["COP", "USD", "EUR"]);
  expect(LocaleCode.options).toEqual(["es-CO"]);
});
