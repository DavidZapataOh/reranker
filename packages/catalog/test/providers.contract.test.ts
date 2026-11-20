import { randomUUID } from "node:crypto";
import { endPools } from "@reranker/db";
import type { SpendContext } from "@reranker/jobs";
import { ParaphraseFormat } from "@reranker/schema/measurement";
import { requireEnv } from "@reranker/testing/env";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { type DraftIntent, embed, generateParaphrases, judge } from "../src/generate/providers";

const spend: SpendContext = {
  purpose: "contract-test",
  refType: "catalog-contract",
  refId: randomUUID(),
};
const ctx = () => ({ spend, signal: AbortSignal.timeout(30_000), deadlineAt: Date.now() + 30_000 });

const bakery: DraftIntent = {
  category: {
    key: "gen:places:bakery",
    source: "places_type",
    label: "Panadería",
    noun: "panadería",
    archetype: "food",
    scope: "local",
    register: "tu",
    placesTypes: ["bakery"],
  },
  scope: "local",
  kind: "discovery",
  slug: "discovery",
  canonicalText: "¿Qué panadería me recomiendas en {lugar}?",
  language: "es",
  registerProfile: "co",
};

beforeAll(() => {
  // The env helpers read APP_ENV, which the contract job does not set.
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
  vi.stubEnv("OPENAI_API_KEY", requireEnv("OPENAI_API_KEY_CI"));
  vi.stubEnv("GEMINI_API_KEY", requireEnv("GEMINI_API_KEY_CI"));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await endPools();
});

// Two paraphrase calls, one embedding and one judge call on a short prompt: about two US cents.
test("one intent comes back as paraphrases, vectors and verdicts from the real providers", async () => {
  const req = { intent: bakery, register: "co", withPersonas: true } as const;
  const [openai, gemini] = await Promise.all([
    generateParaphrases("openai", req, ctx()),
    generateParaphrases("gemini", req, ctx()),
  ]);

  for (const out of [openai, gemini]) {
    expect(out.paraphrases).toHaveLength(12);
    for (const p of out.paraphrases) {
      expect(ParaphraseFormat.parse(p.format)).toBe(p.format);
    }
    expect(out.personas).toHaveLength(3);
  }

  const candidates = [...openai.paraphrases, ...gemini.paraphrases];
  const [vectors, verdicts] = await Promise.all([
    embed(
      candidates.map((c) => c.text),
      ctx(),
    ),
    judge(bakery, candidates, ctx()),
  ]);
  expect(vectors).toHaveLength(candidates.length);
  expect(vectors.every((v) => v.length === 1536)).toBe(true);
  expect(verdicts).toHaveLength(candidates.length);
}, 60_000);
