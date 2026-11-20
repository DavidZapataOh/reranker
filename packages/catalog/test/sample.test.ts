import type { EngineId } from "@reranker/schema";
import { MeasurementPlan } from "@reranker/schema/measurement";
import chisquareCdf from "@stdlib/stats-base-dists-chisquare-cdf";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { getGeo } from "../src/geo/resolve";
import { jcs, sha256Hex } from "../src/hash";
import { planMeasurement } from "../src/sample";
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

// Non-canonical draws of the first intent across many reports, keyed by persona and paraphrase.
// The design forces one variant without persona per intent, so those are drawn more often than
// variants with a persona; within each of the two groups every variant must be equally likely.
function frequencies(reports: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let r = 0; r < reports; r++) {
    const plan = planMeasurement({ ...input(`report-${r}`), engines: ["gemini"], intents: 1 });
    for (const o of plan.observations) {
      if (o.isCanonical) continue;
      const key = `${o.personaId ?? ""}|${o.paraphraseId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function chiSquarePValue(counts: Map<string, number>): number {
  const others = set.paraphrases.filter((p) => p.intentId === set.intents[0]?.intentId).length - 1;
  const groups = [
    { size: others, persona: false },
    { size: others * set.personas.length, persona: true },
  ];
  let statistic = 0;
  for (const group of groups) {
    const observed = [...counts].filter(([key]) => !key.startsWith("|") === group.persona);
    expect(observed).toHaveLength(group.size);
    const expected = observed.reduce((sum, [, n]) => sum + n, 0) / group.size;
    for (const [, n] of observed) statistic += (n - expected) ** 2 / expected;
  }
  return 1 - chisquareCdf(statistic, counts.size - groups.length);
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

  test("uniformity over 10,000 report ids (chi-square p > 0.001)", () =>
    expect(chiSquarePValue(frequencies(10_000))).toBeGreaterThan(0.001));

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
    expect(declared({ chatgpt: "dataforseo" }).chatgpt).toEqual([
      "dataforseo",
      { level: "country", label: "Colombia" },
    ]);
    expect(declared()).toMatchObject({
      chatgpt: ["brightdata", expect.anything()],
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
