import { randomUUID } from "node:crypto";
import { endPools } from "@reranker/db";
import type { SpendContext } from "@reranker/jobs";
import { requireEnv } from "@reranker/testing/env";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { GenerationLanguage } from "../src/generate/prompts";
import { type DraftIntent, judge, reviewNative } from "../src/generate/providers";

const spend: SpendContext = {
  purpose: "contract-test",
  refType: "catalog-judge-contract",
  refId: randomUUID(),
};
const ctx = () => ({ spend, signal: AbortSignal.timeout(60_000), deadlineAt: Date.now() + 60_000 });

// Per language, the ranking canonical of a hotel, its list forms (the same intent) and a change of
// qualifier (another intent). Each line is phrased the way that language's searches read.
type Case = {
  noun: DraftIntent["noun"];
  canonical: string;
  lists: string[];
  otherQualifier: string;
};
const CASES: Record<GenerationLanguage, Case> = {
  es: {
    noun: "hotel",
    canonical: "¿Qué hotel es el mejor en {lugar}?",
    lists: ["Dame los mejores hoteles de {lugar}", "top 5 hoteles en {lugar}"],
    otherQualifier: "¿Qué hotel barato me recomiendas en {lugar}?",
  },
  en: {
    noun: "hotel",
    canonical: "Which hotel is the best in {lugar}?",
    lists: ["List the best hotels in {lugar}", "top 5 hotels in {lugar}"],
    otherQualifier: "Which cheap hotel do you recommend in {lugar}?",
  },
  pt: {
    noun: { text: "hotel", gender: "m" },
    canonical: "Qual é o melhor hotel de {lugar}?",
    lists: ["Me indica os melhores hotéis de {lugar}", "top 5 hotéis em {lugar}"],
    otherQualifier: "Qual hotel barato você recomenda em {lugar}?",
  },
  fr: {
    noun: { text: "hôtel", gender: "m", elides: true },
    canonical: "Quel est le meilleur hôtel à {lugar} ?",
    lists: ["Donne-moi les meilleurs hôtels de {lugar}", "top 5 hôtels à {lugar}"],
    otherQualifier: "Quel hôtel pas cher me conseilles-tu à {lugar} ?",
  },
  de: {
    noun: { text: "Hotel", gender: "n" },
    canonical: "Welches ist das beste Hotel in {lugar}?",
    lists: ["Nenn mir die besten Hotels in {lugar}", "Top 5 Hotels in {lugar}"],
    otherQualifier: "Welches günstige Hotel empfiehlst du in {lugar}?",
  },
  it: {
    noun: { text: "hotel", gender: "m" },
    canonical: "Qual è il miglior hotel di {lugar}?",
    lists: ["Dimmi i migliori hotel di {lugar}", "top 5 hotel a {lugar}"],
    otherQualifier: "Quale hotel economico mi consigli a {lugar}?",
  },
};

beforeAll(() => {
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
  vi.stubEnv("OPENAI_API_KEY", requireEnv("OPENAI_API_KEY_CI"));
  vi.stubEnv("GEMINI_API_KEY", requireEnv("GEMINI_API_KEY_CI"));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await endPools();
});

// Six short judge calls: about one US cent.
test.each(Object.entries(CASES))(
  "%s: a list of the best is the same intent; a cheaper one is not",
  async (language, c) => {
    const text = typeof c.noun === "string" ? c.noun : c.noun.text;
    const intent = {
      category: {
        key: "hotel",
        source: "seed",
        label: text,
        noun: text,
        archetype: "lodging",
        scope: "local",
        register: "tu",
        placesTypes: ["hotel"],
      },
      noun: c.noun,
      scope: "local",
      kind: "ranking",
      slug: "ranking",
      canonicalText: c.canonical,
      language,
      registerProfile: "neutral",
    } as DraftIntent;
    const candidates = [...c.lists, c.otherQualifier].map((t) => ({
      text: t,
      format: "list_request" as const,
      generator: "openai" as const,
    }));
    const verdicts = await judge(intent, candidates, ctx());
    expect(verdicts).toEqual([...c.lists.map(() => true), false]);
  },
);

// Twelve short review calls, one per language and provider: about two US cents.
test.each(Object.entries(CASES))(
  "%s: both native reviewers keep a list of the best and reject a cheaper one",
  async (language, c) => {
    const noun = typeof c.noun === "string" ? c.noun : c.noun.text;
    const req = {
      language: language as GenerationLanguage,
      registerProfile: "neutral" as const,
      category: noun,
      noun,
      intent: { kind: "ranking" as const, canonical: c.canonical },
      items: [...c.lists, c.otherQualifier].map((text) => ({ role: "paraphrase" as const, text })),
    };
    for (const provider of ["openai", "gemini"] as const) {
      const verdicts = await reviewNative(provider, req, ctx());
      expect(verdicts.map((v) => v?.keep)).toEqual([...c.lists.map(() => true), false]);
    }
  },
);
