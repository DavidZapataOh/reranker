import { describe, expect, test, vi } from "vitest";
import {
  buildCategory,
  draftFor,
  fillCanonical,
  groupIntents,
  groupKey,
  MIN_PER_FORMAT,
  namesFor,
  POOL_TARGET,
  rejudgeIntent,
  SEED_GROUPS,
} from "../scripts/build-seed";
import { ARCHETYPE_SLATES } from "../src/archetypes";
import { seedCategories } from "../src/categories";
import type { Candidate } from "../src/generate/guards";
import { AGREEMENT } from "../src/grammar";
import { placeholderShape } from "../src/templates";

const category = (key: string) => {
  const found = seedCategories().find((c) => c.key === key);
  if (!found) throw new Error(key);
  return found;
};

describe("seed intents", () => {
  test("seven groups: Spanish in both profiles, the other languages neutral", () =>
    expect(SEED_GROUPS.map(groupKey)).toEqual([
      "es-co",
      "es-neutral",
      "en-neutral",
      "pt-neutral",
      "fr-neutral",
      "de-neutral",
      "it-neutral",
    ]));

  test.each(SEED_GROUPS.map(groupKey))(
    "%s: eight intents per category, the slate's first five free",
    (key) => {
      const group = SEED_GROUPS.find((g) => groupKey(g) === key) ?? SEED_GROUPS[0];
      for (const c of seedCategories()) {
        const intents = groupIntents(c, group as (typeof SEED_GROUPS)[number]);
        expect(intents).toHaveLength(8);
        expect(intents.slice(0, 6).map((i) => i.kind)).toEqual([...ARCHETYPE_SLATES[c.archetype]]);
        expect(intents.filter((i) => i.freeReport)).toEqual(intents.slice(0, 5));
        for (const i of intents) {
          expect(placeholderShape(i.canonical, c.defaultScope)).toBe("ok");
          // Every agreement group resolves with the language's own noun and gender.
          const filled = fillCanonical(
            i.canonical,
            namesFor(c, group?.language ?? "es").noun,
            group?.language ?? "es",
          );
          expect(filled.match(AGREEMENT)).toBeNull();
        }
      }
    },
  );

  test("ids are unique across the version and label keys are shared by every group", () => {
    const all = SEED_GROUPS.flatMap((g) => seedCategories().flatMap((c) => groupIntents(c, g)));
    expect(new Set(all.map((i) => i.intentId)).size).toBe(all.length);
    const labels = SEED_GROUPS.map((g) =>
      groupIntents(category("hotel"), g).map((i) => i.labelKey),
    );
    for (const l of labels) expect(l).toEqual(labels[0]);
    expect(labels[0]).toContain("catalog.intents.hotel.tonight");
  });

  test("local categories keep a zone question in the free report; the online store asks nationally", () => {
    const group = { language: "es", registerProfile: "co" } as const;
    for (const c of seedCategories()) {
      const zone = groupIntents(c, group).some((i) => i.freeReport && i.kind === "zone");
      expect(zone).toBe(c.defaultScope === "local");
    }
  });

  test("Spanish profiles differ only where the speech does", () => {
    const co = groupIntents(category("real_estate_agency"), {
      language: "es",
      registerProfile: "co",
    });
    const neutral = groupIntents(category("real_estate_agency"), {
      language: "es",
      registerProfile: "neutral",
    });
    const differing = co.filter((i, n) => i.canonical !== neutral[n]?.canonical);
    expect(differing.map((i) => i.labelKey)).toEqual(["catalog.intents.real_estate_agency.rent"]);
  });

  test("a web-only store keeps {sustantivo}, with a gender where the language needs one", () => {
    expect(namesFor(category("online_store"), "es")).toMatchObject({
      noun: "{sustantivo}",
      label: "tienda online",
    });
    expect(namesFor(category("online_store"), "fr").noun).toEqual({
      text: "{sustantivo}",
      gender: "m",
    });
    expect(namesFor(category("dental_clinic"), "de").noun).toEqual({
      text: "Zahnarzt",
      gender: "m",
    });
  });
});

describe("building a category's pools", () => {
  const FORMATS = ["open_question", "list_request", "keyword", "constraint"] as const;
  const DIM = 512;

  function fakes(perCall: (call: number) => number) {
    let calls = 0;
    let index = 0;
    const vectors = new Map<string, Float32Array>();
    const vectorFor = (text: string) => {
      let v = vectors.get(text);
      if (!v) {
        // One shared axis keeps every text on topic; its own axis keeps any two below 0.90.
        v = new Float32Array(DIM);
        v[0] = 1;
        v[1 + (index++ % (DIM - 1))] = 0.6;
        vectors.set(text, v);
      }
      return v;
    };
    return {
      deps: {
        generate: vi.fn(async (provider: "openai" | "gemini", req: { withPersonas: boolean }) => {
          const call = calls++;
          const paraphrases: Candidate[] = Array.from({ length: perCall(call) }, (_, i) => ({
            text: `¿Qué clínica odontológica de ${provider} ${call}-${i} me recomiendas en {lugar}?`,
            format: FORMATS[i % 4] ?? "keyword",
            generator: provider,
          }));
          const personas = req.withPersonas
            ? [`Trabajo hasta muy tarde casi todos los días, cliente ${provider}.`]
            : [];
          return { paraphrases, personas };
        }),
        embed: vi.fn(async (texts: string[]) => texts.map(vectorFor)),
        judge: vi.fn(async (_intent: unknown, candidates: Candidate[]) =>
          candidates.map(() => true),
        ),
      },
    };
  }
  const spend = { purpose: "benchmark" as const, refType: "test", refId: "t" };
  const group = { language: "es", registerProfile: "co" } as const;

  test("one round per intent when both providers fill the pool", async () => {
    const { deps } = fakes(() => 25);
    const built = await buildCategory(category("dental_clinic"), group, spend, deps as never);
    expect(built.intents).toHaveLength(8);
    expect(deps.generate).toHaveBeenCalledTimes(16);
    for (const intent of built.intents) {
      expect(intent.report.rounds).toBe(1);
      expect(intent.pool).toHaveLength(50);
      expect(intent.report.maxPairCosine).toBeLessThan(0.9);
      expect(intent.pool[0]?.closeness).toBeGreaterThanOrEqual(intent.pool.at(-1)?.closeness ?? 1);
    }
    expect(built.personas).toEqual([
      { text: "Trabajo hasta muy tarde casi todos los días, cliente openai.", generator: "openai" },
      { text: "Trabajo hasta muy tarde casi todos los días, cliente gemini.", generator: "gemini" },
    ]);
  });

  test("a short pool asks again, at most five rounds", async () => {
    const { deps } = fakes(() => 3);
    const built = await buildCategory(category("dental_clinic"), group, spend, deps as never);
    for (const intent of built.intents) {
      expect(intent.report.rounds).toBe(5);
      expect(intent.pool.length).toBeLessThan(POOL_TARGET);
    }
    expect(MIN_PER_FORMAT).toBeGreaterThanOrEqual(5);
  });

  test("a later judge rules again on the archived candidates without regenerating", async () => {
    const { deps } = fakes(() => 25);
    const built = await buildCategory(category("dental_clinic"), group, spend, deps as never);
    const intent = built.intents[5];
    if (!intent) throw new Error("no trust intent");
    expect(intent.candidates).toHaveLength(50);
    expect(intent.candidates.every((c) => c.judged)).toBe(true);

    // The new judge rejects every list request the old one kept.
    const judge = vi.fn(async (_intent: unknown, candidates: Candidate[]) =>
      candidates.map((c) => c.format !== "list_request"),
    );
    const plan = { ...intent };
    const draft = draftFor(category("dental_clinic"), group, plan);
    const rejudged = await rejudgeIntent(intent, draft, spend, {
      embed: deps.embed,
      judge,
    } as never);

    expect(deps.generate).toHaveBeenCalledTimes(16);
    expect(rejudged.candidates.map((c) => c.text)).toEqual(intent.candidates.map((c) => c.text));
    expect(rejudged.pool.some((p) => p.format === "list_request")).toBe(false);
    expect(rejudged.pool.length).toBeLessThan(intent.pool.length);
    expect(rejudged.report.rounds).toBe(intent.report.rounds);
  });
});
