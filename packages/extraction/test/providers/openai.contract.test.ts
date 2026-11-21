import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { endPools } from "@reranker/db";
import { releaseSpend, reserveSpend, type SpendContext, settleSpend } from "@reranker/jobs";
import { requireEnv } from "@reranker/testing/env";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { costOfUsage, estimateOf } from "../../src/prices";
import { EXTRACT_PROMPT_V2 } from "../../src/prompts/extract.v2";
import { callOpenAI } from "../../src/providers/openai";
import { MentionsSchema } from "../../src/schema";

const MODEL = "gpt-6-luna";
const MAX_OUTPUT_TOKENS = 4096;
const answer = readFileSync(
  new URL("../fixtures/answers/dental-medellin.md", import.meta.url),
  "utf8",
);

const spend: SpendContext = {
  purpose: "contract-test",
  refType: "openai-contract",
  refId: randomUUID(),
};

beforeAll(() => {
  // The env helpers read APP_ENV, which the contract job does not set.
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
  vi.stubEnv("OPENAI_API_KEY", requireEnv("OPENAI_API_KEY_CI"));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await endPools();
});

// One gpt-6-luna extraction of a short fixed answer per run, well under one US cent.
test("a real answer comes back as valid mentions JSON from gpt-6-luna", async () => {
  const reservation = await reserveSpend({
    provider: "openai",
    estimate: estimateOf(MODEL, 6000, MAX_OUTPUT_TOKENS),
    ...spend,
  });
  const result = await callOpenAI({
    model: { provider: "openai", model: MODEL, reasoning: "low" },
    system: EXTRACT_PROMPT_V2,
    user: answer,
    schema: MentionsSchema,
    schemaName: "mentions",
    signal: AbortSignal.timeout(30_000),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  }).catch(async (error: unknown) => {
    await releaseSpend(reservation);
    throw error;
  });
  await settleSpend(reservation, costOfUsage(MODEL, result.usage));

  expect(MentionsSchema.parse(result.output)).toEqual(result.output);
  expect(result.output.answerKind).toBe("names_entities");
  expect(result.output.mentions.length).toBeGreaterThanOrEqual(1);
  expect(result.modelReported).not.toBe("");
  expect(result.usage.inputTokens).toBeGreaterThan(0);
  expect(result.usage.outputTokens).toBeGreaterThan(0);
}, 60_000);
