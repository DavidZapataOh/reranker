import { ProviderUnavailableError } from "@reranker/jobs";
import { type BusinessCategory, IntentSet } from "@reranker/schema/measurement";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateIntentSet, templateIntentSet } from "../src/generate/pipeline";
import type { DraftIntent } from "../src/generate/providers";
import { intentSetId, variantTemplates } from "../src/hash";
import { MeasurementLanguageError } from "../src/language";

type Provider = "openai" | "gemini";
type Req = { intent: DraftIntent; withPersonas: boolean };
type Ctx = { signal: AbortSignal };

const doubles = vi.hoisted(() => ({
  enabled: true,
  promptless: new Set<string>(),
  untemplated: new Set<string>(),
  generate: vi.fn(),
  embed: vi.fn(),
  judge: vi.fn(),
}));

vi.mock("@reranker/flags", () => ({ isEnabled: async () => doubles.enabled }));
vi.mock("../src/generate/providers", () => ({
  generateParaphrases: doubles.generate,
  embed: doubles.embed,
  judge: doubles.judge,
}));
vi.mock("../src/generate/prompts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/generate/prompts")>();
  return {
    ...original,
    isGenerationLanguage: (l: string) =>
      !doubles.promptless.has(l) && original.isGenerationLanguage(l as never),
  };
});

// Every measurement language gets templates eventually; one is withdrawn here to see the refusal.
vi.mock("../src/templates", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/templates")>();
  const { MeasurementLanguageError } = await import("../src/language");
  return {
    ...original,
    fallbackTemplates: (...args: Parameters<typeof original.fallbackTemplates>) => {
      const language = args[2];
      if (doubles.untemplated.has(language)) {
        throw new MeasurementLanguageError(language, "no_templates", `no ${language} templates`);
      }
      return original.fallbackTemplates(...args);
    },
  };
});

const spend = { purpose: "contract-test" as const, refType: "test", refId: "ref-1" };
const FORMATS = ["open_question", "list_request", "keyword", "constraint"] as const;

const category = (noun: string, label: string): BusinessCategory => ({
  key: "gen:places:bakery",
  source: "places_type",
  label,
  noun,
  archetype: "food",
  scope: "local",
  register: "tu",
  placesTypes: ["bakery"],
});
const bakery = (over: { deadlineAt?: number; language?: "es" | "en" } = {}) => ({
  category:
    over.language === "en" ? category("bakery", "Bakery") : category("panadería", "Panadería"),
  scope: "local" as const,
  registerProfile: "co" as const,
  language: over.language ?? ("es" as const),
  deadlineAt: over.deadlineAt ?? Date.now() + 12_000,
  spend,
});

// Each text gets its own direction around a shared axis: on topic (≈ 0.77 to each other, well
// under the 0.90 dedupe) unless it says "twin" (same vector as its sibling) or "far" (orthogonal).
// Closeness alternates, so both providers' paraphrases rank among the closest.
const DIMS = 512;
let axes = new Map<string, number>();
function vector(text: string): Float32Array {
  const key = text.includes("twin") ? text.replace(/twin \d/, "twin") : text;
  if (!axes.has(key)) axes.set(key, axes.size + 1);
  const v = new Float32Array(DIMS);
  const axis = axes.get(key) as number;
  if (!text.includes("far")) v[0] = 1;
  v[axis] = 0.5 + 0.1 * (axis % 2);
  return v;
}

const lines = (provider: Provider, texts: (i: number) => string) =>
  Array.from({ length: 12 }, (_, i) => ({
    text: texts(i),
    format: FORMATS[i % 4] ?? "keyword",
    generator: provider,
  }));
const spanish = (provider: Provider, intent: DraftIntent) =>
  lines(
    provider,
    (i) => `¿qué ${intent.category.noun} ${intent.slug} ${provider} ${i} hay en {lugar}?`,
  );
const PERSONAS = [
  "Trabajo hasta tarde y tengo dos hijos pequeños.",
  "Soy estudiante y casi siempre como fuera de casa.",
  "Llámenme al 3001234567 cuando puedan, por favor.",
  "Tengo una reunión familiar el fin de semana y busco opciones.",
];

let paraphrasesOf: (provider: Provider, intent: DraftIntent) => unknown[];
const failing = new Set<Provider>();
const hanging = new Set<Provider>();

beforeEach(() => {
  axes = new Map();
  doubles.enabled = true;
  doubles.promptless.clear();
  doubles.untemplated.clear();
  failing.clear();
  hanging.clear();
  paraphrasesOf = spanish;
  doubles.generate.mockImplementation(async (provider: Provider, req: Req, _ctx: Ctx) => {
    if (failing.has(provider)) throw new ProviderUnavailableError(provider, 1000);
    // Ignores the abort, as a provider that never answers would.
    if (hanging.has(provider)) return new Promise(() => {});
    return {
      paraphrases: paraphrasesOf(provider, req.intent),
      personas: req.withPersonas ? PERSONAS : [],
    };
  });
  doubles.embed.mockImplementation(async (texts: string[]) => texts.map(vector));
  doubles.judge.mockImplementation(async (_: DraftIntent, candidates: { text: string }[]) =>
    candidates.map((c) => !c.text.includes("nope")),
  );
});
afterEach(() => vi.clearAllMocks());

const calls = () =>
  doubles.generate.mock.calls.length +
  doubles.embed.mock.calls.length +
  doubles.judge.mock.calls.length;

// What sealing will do; the draft must already be a valid set once it has its ids.
function sealed(draft: Awaited<ReturnType<typeof generateIntentSet>>["set"]) {
  const id = intentSetId("0".repeat(64));
  return IntentSet.parse({
    manifest: { ...draft.manifest, id, contentHash: "0".repeat(64), merkleRoot: "0".repeat(64) },
    intents: draft.intents.map((i) => ({ ...i, intentSetId: id })),
    paraphrases: draft.paraphrases,
    personas: draft.personas,
  });
}

describe("generateIntentSet", () => {
  test("both providers up: the whole slate complete, five in the free report, generators 2", async () => {
    const r = await generateIntentSet(bakery());

    expect(r.outcome).toBe("generated");
    expect(r.generators).toBe(2);
    const set = sealed(r.set);
    expect(set.intents).toHaveLength(6);
    expect(set.intents.filter((i) => i.freeReport)).toHaveLength(5);
    expect(set.intents.every((i) => i.language === "es" && i.registerProfile === "co")).toBe(true);
    for (const intent of set.intents) {
      const own = set.paraphrases.filter((p) => p.intentId === intent.intentId);
      expect(own).toHaveLength(13);
      expect(own[0]).toMatchObject({
        paraphraseId: intent.canonicalParaphraseId,
        text: intent.canonicalText,
      });
      expect(own.filter((p) => p.format === "keyword").length).toBeGreaterThanOrEqual(2);
    }
    // The persona with a phone number is dropped; three is the cap.
    expect(set.personas.map((p) => p.preamble)).toEqual([PERSONAS[0], PERSONAS[1], PERSONAS[3]]);
    expect(set.manifest).toMatchObject({ kind: "generated", generators: 2 });
    expect(set.manifest.generatorConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(set.manifest.variantCount).toBe(variantTemplates(set).length);
    expect(r.report.fallback).toBeNull();
  });

  test("the noun reaches the models in the canonical; the set keeps the template's placeholder", async () => {
    const r = await generateIntentSet(bakery());
    const asked = doubles.generate.mock.calls.map(([, req]) => (req as Req).intent);
    expect(asked[0]?.canonicalText).toBe("¿Qué panadería me recomiendas en {lugar}?");
    expect(r.set.intents[0]?.canonicalText).toBe("¿Qué {sustantivo} me recomiendas en {lugar}?");
    expect(doubles.generate.mock.calls.filter(([, req]) => (req as Req).withPersonas)).toHaveLength(
      2,
    );
  });

  test("one provider down: generators 1", async () => {
    failing.add("gemini");
    const r = await generateIntentSet(bakery());
    expect(r.outcome).toBe("generated");
    expect(r.generators).toBe(1);
    expect(r.set.paraphrases.some((p) => p.generator === "gemini")).toBe(false);
  });

  test("both down: the template, within the deadline", async () => {
    failing.add("openai").add("gemini");
    const t0 = Date.now();
    const r = await generateIntentSet(bakery({ deadlineAt: t0 + 12_000 }));
    expect(r.outcome).toBe("template");
    expect(r.generators).toBe(0);
    expect(r.report.fallback).toBe("incomplete");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("a provider that never answers is cut at the deadline and the set is built from what arrived", async () => {
    hanging.add("gemini");
    const t0 = Date.now();
    const r = await generateIntentSet(bakery({ deadlineAt: t0 + 5000 }));
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.outcome).toBe("generated");
    expect(r.generators).toBe(1);
  });

  test.each([
    ["already past", -1],
    ["50 ms away", 50],
  ])("a deadline %s returns the template without any provider call", async (_, ms) => {
    const t0 = Date.now();
    const r = await generateIntentSet(bakery({ deadlineAt: t0 + ms }));
    expect(r.outcome).toBe("template");
    expect(r.report.fallback).toBe("no_time");
    expect(calls()).toBe(0);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test("kill switch off: the template and no calls", async () => {
    doubles.enabled = false;
    const r = await generateIntentSet(bakery());
    expect(r.outcome).toBe("template");
    expect(r.report.fallback).toBe("disabled");
    expect(calls()).toBe(0);
  });

  test("guards rejecting everything fall back to the template before any embedding", async () => {
    paraphrasesOf = (provider, intent) =>
      lines(provider, (i) => `${intent.category.noun} ${provider} ${i}`);
    const r = await generateIntentSet(bakery());
    expect(r.outcome).toBe("template");
    expect(r.report.guards.placeholder).toBe(144);
    expect(doubles.embed).not.toHaveBeenCalled();
  });

  test("the filter report counts rejects per guard, dedupe, centroid and judge", async () => {
    paraphrasesOf = (provider, intent) => {
      const own = spanish(provider, intent);
      if (provider !== "openai" || intent.kind !== "discovery") return own;
      const odd = [
        "¿qué panadería twin 1 hay en {lugar}?",
        "¿qué panadería twin 2 hay en {lugar}?",
        "¿qué panadería far hay en {lugar}?",
        "¿qué panadería nope hay en {lugar}?",
        "panadería en {lugar}, escribe a ana@example.com",
        "¿qué panadería barata hay en {lugar}?",
      ];
      return own.map((p, i) => ({ ...p, text: odd[i] ?? p.text }));
    };
    const { report } = await generateIntentSet(bakery());
    expect(report).toMatchObject({ dedupe: 1, offCentroid: 1, judge: 1, candidates: 144 });
    expect(report.guards).toMatchObject({ personal_data: 1, qualifier: 1, placeholder: 0 });
    expect(report.complete).toBe(6);
  });

  test("English intents are written, guarded and judged in English", async () => {
    paraphrasesOf = (provider, intent) =>
      lines(provider, (i) =>
        i === 0 && intent.kind === "discovery"
          ? "cheap bakery options in {lugar}"
          : `which ${intent.category.noun} ${intent.slug} ${provider} ${i} is in {lugar}?`,
      );
    const r = await generateIntentSet(bakery({ language: "en" }));

    expect(r.outcome).toBe("generated");
    const asked = doubles.generate.mock.calls.map(([, req]) => (req as Req).intent);
    expect(asked.every((i) => i.language === "en")).toBe(true);
    expect(asked[0]?.canonicalText).toBe("Can you recommend a good bakery in {lugar}?");
    // "cheap" is a price word only the English lexicon knows.
    expect(r.report.guards.qualifier).toBe(1);
    expect(r.set.intents.every((i) => i.language === "en")).toBe(true);
  });

  test("Portuguese intents agree with the noun's gender and are guarded in Portuguese", async () => {
    paraphrasesOf = (provider, intent) =>
      lines(provider, (i) => {
        if (intent.kind !== "discovery" || i > 1) {
          return `qual ${intent.category.noun} ${intent.slug} ${provider} ${i} fica em {lugar}?`;
        }
        // "em conta" is a price phrase only the Portuguese lexicon knows; "confeitaria" is a synonym.
        return i === 0
          ? `padaria em conta ${provider} em {lugar}`
          : `alguma confeitaria ${provider} boa em {lugar}?`;
      });
    const r = await generateIntentSet({
      ...bakery(),
      category: category("padaria", "Padaria"),
      noun: { text: "padaria", gender: "f" },
      synonyms: ["confeitaria"],
      language: "pt",
    });

    expect(r.outcome).toBe("generated");
    const asked = doubles.generate.mock.calls.map(([, req]) => (req as Req).intent);
    expect(asked.every((i) => i.language === "pt" && i.category.noun === "padaria")).toBe(true);
    expect(asked.find((i) => i.kind === "ranking")?.canonicalText).toBe(
      "Qual a melhor padaria em {lugar}?",
    );
    expect(r.report.guards).toMatchObject({ qualifier: 2, category_noun: 0 });
    expect(r.set.intents.every((i) => i.language === "pt")).toBe(true);
  });

  test("a gendered language without the noun's gender is refused, never written as masculine", async () => {
    const input = { ...bakery(), category: category("padaria", "Padaria"), language: "pt" };
    await expect(
      generateIntentSet(input as unknown as Parameters<typeof generateIntentSet>[0]),
    ).rejects.toEqual(expect.objectContaining({ language: "pt", gap: "no_noun_gender" }));
    await expect(
      generateIntentSet({ ...input, noun: "padaria" } as unknown as Parameters<
        typeof generateIntentSet
      >[0]),
    ).rejects.toBeInstanceOf(MeasurementLanguageError);
    expect(calls()).toBe(0);
  });

  test("French intents agree with the noun's gender and are guarded in French", async () => {
    paraphrasesOf = (provider, intent) =>
      lines(provider, (i) =>
        // "pas cher" is a price phrase only the French lexicon knows.
        intent.kind === "discovery" && i === 0
          ? `boulangerie pas cher ${provider} à {lugar}`
          : `quelle ${intent.category.noun} ${intent.slug} ${provider} ${i} à {lugar} ?`,
      );
    const r = await generateIntentSet({
      ...bakery(),
      category: category("boulangerie", "Boulangerie"),
      noun: { text: "boulangerie", gender: "f" },
      language: "fr",
    });

    expect(r.outcome).toBe("generated");
    const asked = doubles.generate.mock.calls.map(([, req]) => (req as Req).intent);
    expect(asked.every((i) => i.language === "fr")).toBe(true);
    expect(asked.find((i) => i.kind === "ranking")?.canonicalText).toBe(
      "Quelle est la meilleure boulangerie à {lugar} ?",
    );
    expect(r.report.guards.qualifier).toBe(2);
    expect(r.set.intents.every((i) => i.language === "fr")).toBe(true);
  });

  test.each([
    {
      language: "de" as const,
      noun: "Bäckerei",
      text: (slug: string, provider: string, i: number) =>
        `welche Bäckerei ${slug} ${provider} ${i} in {lugar}?`,
      // "günstig" is a price word only the German lexicon knows.
      foreign: "günstige Bäckerei in {lugar}",
      ranking: "Welche ist die beste Bäckerei in {lugar}?",
    },
    {
      language: "it" as const,
      noun: "panetteria",
      text: (slug: string, provider: string, i: number) =>
        `quale panetteria ${slug} ${provider} ${i} a {lugar}?`,
      // "economica" is a price word only the Italian lexicon knows.
      foreign: "panetteria economica a {lugar}",
      ranking: "Qual è la panetteria migliore a {lugar}?",
    },
  ])("$language intents agree with the noun's gender and are guarded in $language", async (c) => {
    paraphrasesOf = (provider, intent) =>
      lines(provider, (i) =>
        intent.kind === "discovery" && i === 0
          ? `${c.foreign} ${provider}`
          : c.text(intent.slug, provider, i),
      );
    const r = await generateIntentSet({
      ...bakery(),
      category: category(c.noun, c.noun),
      noun: { text: c.noun, gender: "f" },
      language: c.language,
    });

    expect(r.outcome).toBe("generated");
    const asked = doubles.generate.mock.calls.map(([, req]) => (req as Req).intent);
    expect(asked.every((i) => i.language === c.language)).toBe(true);
    expect(asked.find((i) => i.kind === "ranking")?.canonicalText).toBe(c.ranking);
    expect(r.report.guards.qualifier).toBe(2);
    expect(r.set.intents.every((i) => i.language === c.language)).toBe(true);
  });

  test("a language without reviewed prompts gets its own templates, never Spanish ones, and no calls", async () => {
    doubles.promptless.add("en");
    const r = await generateIntentSet(bakery({ language: "en" }));
    expect(r.outcome).toBe("template");
    expect(r.report.fallback).toBe("no_prompts");
    expect(r.set.intents.every((i) => i.language === "en")).toBe(true);
    expect(r.set.intents[0]?.canonicalText).toBe(
      "Can you recommend a good {sustantivo} in {lugar}?",
    );
    expect(calls()).toBe(0);
  });

  test("a language without templates is refused with a typed error", async () => {
    doubles.untemplated.add("en");
    await expect(generateIntentSet(bakery({ language: "en" }))).rejects.toBeInstanceOf(
      MeasurementLanguageError,
    );
    expect(calls()).toBe(0);
  });
});

describe("templateIntentSet", () => {
  test("the archetype's reviewed templates in the asked language, sealed later", () => {
    const draft = templateIntentSet(category("bakery", "Bakery"), "local", "neutral", "en");
    const set = sealed(draft);
    expect(set.manifest).toMatchObject({
      kind: "template",
      generators: 0,
      generatorConfigHash: null,
    });
    expect(set.intents.map((i) => i.kind)).toEqual([
      "discovery",
      "specialty",
      "zone",
      "price",
      "trust",
      "ranking",
    ]);
    expect(set.paraphrases.every((p) => p.generator === "template" && p.humanReviewed)).toBe(true);
    expect(set.personas).toEqual([]);
    expect(set.manifest.variantCount).toBe(set.paraphrases.length);
  });
});
