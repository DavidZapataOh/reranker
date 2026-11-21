import type { EngineId } from "@reranker/schema";
import { MeasurementPlan } from "@reranker/schema/measurement";
import { rngFromSeed } from "@reranker/stats";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { getGeo } from "../src/geo/resolve";
import { jcs, sha256Hex, variantTemplates } from "../src/hash";
import { drawVariants, planMeasurement } from "../src/sample";
import { variantPool } from "../src/variants";
import { dentalSet } from "./fixtures/intent-set";

const ENGINES: readonly EngineId[] = [
  "chatgpt",
  "gemini",
  "google-ai-overview",
  "google-ai-mode",
  "perplexity",
];
const set = dentalSet();
const geo = getGeo("co-c1003659");

const input = (reportId: string) => ({
  intentSet: set,
  geo,
  scope: "local" as const,
  neighborhood: "Chapinero",
  noun: "clínica odontológica",
  engines: ENGINES,
  reportId,
});

const kindOf = new Map(set.intents.map((i) => [i.intentId, i.kind]));

function checkDesign(plan: MeasurementPlan): void {
  const first = plan.observations.filter((o) => o.engine === ENGINES[0]);
  for (const variants of Map.groupBy(first, (o) => o.intentId).values()) {
    expect(variants).toHaveLength(8);
    const [canonical, ...rest] = variants;
    expect(canonical?.isCanonical).toBe(true);
    expect(canonical?.personaId).toBeUndefined();
    expect(rest.every((v) => !v.isCanonical)).toBe(true);
    expect(new Set(variants.map((v) => v.paraphraseId)).size).toBe(8);
    const perPersona = Map.groupBy(rest, (v) => v.personaId ?? null);
    for (const [persona, vs] of perPersona) if (persona !== null) expect(vs.length).toBeLessThan(3);
    expect(perPersona.get(null)?.length ?? 0).toBeGreaterThan(0);
  }
}

describe("planMeasurement", () => {
  test("same report id and set give the same plan byte for byte", () =>
    expect(jcs(planMeasurement(input("r-1")))).toEqual(jcs(planMeasurement(input("r-1")))));

  test("different report ids draw different variants", () =>
    expect(jcs(planMeasurement(input("r-1")))).not.toEqual(jcs(planMeasurement(input("r-9")))));

  test("200 observations, the same 8 variants on every engine", () => {
    const plan = planMeasurement(input("r-2"));
    expect(MeasurementPlan.parse(plan)).toEqual(plan);
    expect(plan.observations).toHaveLength(200);
    const perEngine = Map.groupBy(plan.observations, (o) => o.engine);
    expect([...perEngine.keys()]).toEqual(ENGINES);
    const ids = [...perEngine.values()].map((os) =>
      os
        .map((o) => o.variantId)
        .sort()
        .join(),
    );
    expect(new Set(ids).size).toBe(1);
    expect(plan.design).toEqual({ intents: 5, variantsPerIntent: 8, runsPerVariant: 1 });
    expect(plan.intentSet).toEqual(set.manifest);
    expect(plan.observations.every((o) => o.intentSetId === set.manifest.id)).toBe(true);
  });

  test("observations are ordered by intent, variant and engine", () => {
    const plan = planMeasurement(input("r-2"));
    const rank = (o: (typeof plan.observations)[number]) => [
      set.intents.findIndex((i) => i.intentId === o.intentId),
      ENGINES.indexOf(o.engine),
    ];
    plan.observations.forEach((o, i) => {
      expect(o.engine).toBe(ENGINES[i % ENGINES.length]);
      if (i % ENGINES.length > 0) expect(o.variantId).toBe(plan.observations[i - 1]?.variantId);
      const next = plan.observations[i + 1];
      if (next) expect(rank(next)[0]).toBeGreaterThanOrEqual(rank(o)[0] ?? 0);
    });
  });

  test("property: per intent the canonical comes first, paraphrases never repeat, at most 2 per persona and one more without persona", () =>
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (reportId) =>
        checkDesign(planMeasurement(input(reportId))),
      ),
    ));

  test("free-report intents go first, in the set order", () => {
    const plan = planMeasurement(input("r-3"));
    expect([...new Set(plan.observations.map((o) => o.intentId))]).toEqual(
      set.intents.filter((i) => i.freeReport).map((i) => i.intentId),
    );
  });

  test("no neighborhood skips zone intents and still plans 5 intents", () => {
    const plan = planMeasurement({ ...input("r-3"), neighborhood: null });
    const intents = new Set(plan.observations.map((o) => o.intentId));
    expect(intents.size).toBe(5);
    expect([...intents].every((id) => kindOf.get(id) !== "zone")).toBe(true);
    expect([...intents].at(-1)).toBe(set.intents.find((i) => !i.freeReport)?.intentId);
  });

  test("brand intents are never planned, and too few intents is an internal error", () => {
    const branded = {
      ...set,
      intents: set.intents.map((i) => (i.freeReport ? i : { ...i, kind: "brand" as const })),
    };
    expect(() =>
      planMeasurement({ ...input("r-3"), intentSet: branded, neighborhood: null }),
    ).toThrow(expect.objectContaining({ code: "internal" }));
  });

  test("prompt text has the place filled and its sha256", () => {
    const o = planMeasurement(input("r-4")).observations[0];
    expect(o?.promptText).not.toMatch(/\{(lugar|zona|país|sustantivo)\}/);
    // People ask for Bogotá, not for its legal designation "Bogotá, D.C.".
    expect(o?.promptText).toBe("¿Qué clínica odontológica me recomiendas en Bogotá?");
    expect(o?.promptSha256).toBe(sha256Hex(o?.promptText ?? ""));
  });

  test("geoDeclared comes from geoForEngine with the planned provider", () => {
    const declared = (providers?: Parameters<typeof planMeasurement>[0]["providers"]) => {
      const o = planMeasurement({
        ...input("r-5"),
        ...(providers ? { providers } : {}),
      }).observations;
      return Object.fromEntries(o.map((x) => [x.engine, [x.provider, x.geoDeclared]]));
    };
    // A paid report asks Bright Data, which answers from a coordinate but outlasts the free
    // report's budget.
    expect(declared({ chatgpt: "brightdata" }).chatgpt).toEqual([
      "brightdata",
      expect.objectContaining({ label: expect.any(String) }),
    ]);
    expect(declared()).toMatchObject({
      chatgpt: ["dataforseo", { level: "country", label: "Colombia" }],
      perplexity: ["brightdata", { level: "country", label: "Colombia" }],
      gemini: ["dataforseo", { level: "city", label: "Bogotá, D.C." }],
      "google-ai-mode": ["dataforseo", { level: "city" }],
    });
  });

  test("the plan carries no undefined fields", () => {
    const plan = planMeasurement(input("r-6"));
    const withoutPersona = plan.observations.find((o) => o.isCanonical);
    expect(withoutPersona && Object.hasOwn(withoutPersona, "personaId")).toBe(false);
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  test("a pool smaller than variantsPerIntent is an internal error", () =>
    expect(() => planMeasurement({ ...input("r-6"), variantsPerIntent: 400 })).toThrow(
      expect.objectContaining({ code: "internal" }),
    ));

  test("a set for another scope or no measurable engine is an internal error", () => {
    expect(() => planMeasurement({ ...input("r-6"), scope: "national" })).toThrow(
      expect.objectContaining({ code: "internal" }),
    );
    expect(() => planMeasurement({ ...input("r-6"), engines: [] })).toThrow(
      expect.objectContaining({ code: "internal" }),
    );
  });

  test("the sampler seed is sha256(reportId) as hex", () =>
    expect(planMeasurement(input("r-7")).seed).toBe(sha256Hex("r-7")));
});

describe("a seed intent shorter than 30 paraphrases", () => {
  // Twelve paraphrases per intent, the canonical among them: what a narrow seed intent can end with.
  const short = {
    ...set,
    paraphrases: set.intents.flatMap((intent) => {
      const own = set.paraphrases.filter((p) => p.intentId === intent.intentId);
      const extra = [9, 10, 11].map((n) => ({
        ...(own[1] as (typeof own)[number]),
        paraphraseId: `${intent.intentId}.p${n}`,
        text: `${own[1]?.text} (${n})`,
      }));
      return [...own, ...extra];
    }),
  };
  const plan = (reportId: string) => planMeasurement({ ...input(reportId), intentSet: short });

  test("each intent really has 12 paraphrases and its variant count is 12 × (personas + 1)", () => {
    const perIntent = Map.groupBy(short.paraphrases, (p) => p.intentId);
    for (const ps of perIntent.values()) expect(ps).toHaveLength(12);
    const templates = variantTemplates(short);
    expect(templates).toHaveLength(short.intents.length * 12 * (short.personas.length + 1));
    expect(new Set(templates.map((t) => `${t.paraphraseId}|${t.personaId}`)).size).toBe(
      templates.length,
    );
  });

  test("property: the plan keeps its design, no paraphrase drawn twice", () =>
    fc.assert(fc.property(fc.string({ minLength: 1 }), (reportId) => checkDesign(plan(reportId)))));

  // The plan's first draw for a report: its first intent, seeded by sha256(reportId).
  const firstIntent = short.intents.find((i) => i.freeReport) as (typeof short.intents)[number];
  const pool = variantPool(short, firstIntent);
  const draw = (reportId: string) => drawVariants(pool, 8, rngFromSeed(sha256Hex(reportId)));

  test("the plan draws exactly what drawVariants draws from the report's seed", () => {
    for (const reportId of ["report-0", "report-1", "report-2"]) {
      const one = planMeasurement({ ...input(reportId), intentSet: short, engines: ["gemini"] });
      const firstDraw = one.observations.filter((o) => o.intentId === firstIntent.intentId);
      expect(firstDraw.map((o) => o.paraphraseId)).toEqual(
        draw(reportId).map((c) => c.paraphraseId),
      );
    }
  });

  // Draws alone, not whole plans: materializing 3,000 plans is CPU-bound and outran the test
  // timeout on a loaded CI runner.
  test("every non-canonical paraphrase is drawn equally often", () => {
    const runs = 3000;
    const counts = new Map<string, number>();
    for (let r = 0; r < runs; r++) {
      for (const c of draw(`report-${r}`)) {
        if (!c.isCanonical) counts.set(c.paraphraseId, (counts.get(c.paraphraseId) ?? 0) + 1);
      }
    }
    // Seven draws among the eleven paraphrases that are not the canonical's.
    expect(counts.size).toBe(11);
    for (const n of counts.values()) expect(Math.abs(n / runs - 7 / 11)).toBeLessThan(0.04);
  });
});
