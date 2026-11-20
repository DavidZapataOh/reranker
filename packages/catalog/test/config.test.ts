import { cost } from "@reranker/schema";
import { expect, test } from "vitest";
import {
  costOf,
  estimateOf,
  GENERATOR_CONFIG,
  type GeneratorConfig,
  generatorConfigHash,
} from "../src/generate/config";
import { jcs, sha256Hex } from "../src/hash";
import { TEMPLATE_LANGUAGES, templatesVersion } from "../src/templates";

const hashOf = (config: GeneratorConfig) => sha256Hex(jcs(config));

test("generator config hash is stable and changes with any field", () => {
  expect(generatorConfigHash).toMatch(/^[0-9a-f]{64}$/);
  expect(generatorConfigHash).toBe(hashOf(GENERATOR_CONFIG));
  expect(hashOf({ ...GENERATOR_CONFIG, dedupe: 0.91 } as unknown as GeneratorConfig)).not.toBe(
    generatorConfigHash,
  );
  const prompts = { ...GENERATOR_CONFIG.prompts, judge: sha256Hex("otro juez") };
  expect(hashOf({ ...GENERATOR_CONFIG, prompts })).not.toBe(generatorConfigHash);
});

test("the config pins every language's templates, so a new set in any language changes the hash", () => {
  for (const language of TEMPLATE_LANGUAGES) {
    expect(GENERATOR_CONFIG.templatesVersions[language]).toBe(templatesVersion(language));
  }
  const templatesVersions = { ...GENERATOR_CONFIG.templatesVersions, en: "2027.01.0" };
  expect(hashOf({ ...GENERATOR_CONFIG, templatesVersions })).not.toBe(generatorConfigHash);
});

test("the config is frozen so the hash cannot drift at runtime", () => {
  expect(Object.isFrozen(GENERATOR_CONFIG)).toBe(true);
  expect(Object.isFrozen(GENERATOR_CONFIG.models)).toBe(true);
});

const usage = {
  inputTokens: 2000,
  cachedInputTokens: 500,
  cacheWriteTokens: 100,
  outputTokens: 800,
};

test("costs follow each model's list price, rounded up to the micro-USD", () => {
  // 1400 × 1 + 500 × 0.05 + 100 × 1.25 + 800 × 5 USD per 1M tokens.
  expect(costOf("gpt-6.1-terra", usage)).toEqual(cost(5550, "USD"));
  expect(
    costOf("text-embedding-3-small", {
      ...usage,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    }),
  ).toEqual(cost(40, "USD"));
  expect(
    costOf("text-embedding-3-small", {
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    }),
  ).toEqual(cost(1, "USD"));
});

test("gemini-3.8-flash doubles its price from January 2027, Pacific time", () => {
  const flash = {
    inputTokens: 2000,
    cachedInputTokens: 400,
    cacheWriteTokens: 0,
    outputTokens: 800,
  };
  expect(costOf("gemini-3.8-flash", flash, new Date("2027-01-01T07:59:59Z"))).toEqual(
    cost(4230, "USD"),
  );
  expect(costOf("gemini-3.8-flash", flash, new Date("2027-01-01T08:00:00Z"))).toEqual(
    cost(8460, "USD"),
  );
});

test("an estimate prices every input token at its dearest rate", () => {
  // 1000 × 1.25 + 2048 × 5 USD per 1M tokens.
  expect(estimateOf("gpt-6.1-terra", 1000, 2048)).toEqual(cost(11_490, "USD"));
});
