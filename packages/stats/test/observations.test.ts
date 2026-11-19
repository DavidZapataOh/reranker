import type { EngineId } from "@reranker/schema";
import { describe, expect, test } from "vitest";
import { buildObservations, type ObservationFrame } from "../src/observations";
import { estimateScore } from "../src/score";
import { SEED } from "./fixtures";
import {
  CONFIG,
  captureId,
  ENGINES,
  fixture,
  INTENTS,
  mention,
  RIVAL,
  slotOf,
  TARGET,
} from "./fixtures/report-200";

// Captures carry their stratum's weight W_h, so an engine's mass is the sum over its strata.
function engineWeightSum(f: ObservationFrame, engine: EngineId): number {
  const strata = new Map<string, number>();
  for (const c of f.captures) if (c.engine === engine) strata.set(c.stratum, c.weight);
  return [...strata.values()].reduce((a, b) => a + b, 0);
}

const indexOf = (f: ObservationFrame, slot: number) =>
  f.captures.findIndex((c) => c.captureId === captureId(slot));

describe("buildObservations", () => {
  test("denominator: succeeded captures, present or not; failures excluded", () => {
    const f = buildObservations(
      fixture({ failed: { chatgpt: 3 }, notPresent: { "google-ai-overview": 12 } }),
    );
    expect(f.engines.find((e) => e.engine === "chatgpt")).toMatchObject({
      planned: 40,
      valid: 37,
      failed: 3,
      notPresent: 0,
      included: true,
    });
    expect(f.engines.find((e) => e.engine === "google-ai-overview")).toMatchObject({
      planned: 40,
      valid: 40,
      failed: 0,
      notPresent: 12,
    });
    expect(f.captures).toHaveLength(197);
    const absent = f.captures[indexOf(f, slotOf("google-ai-overview", 0, 0))];
    expect(absent).toMatchObject({ present: false, namesEntities: false });
    expect(f.extractorConfigHash).toBe(CONFIG);
  });

  test("criterion 9: an engine with 15 of 40 valid is excluded and the other four weigh 1/4", () => {
    const f = buildObservations(fixture({ failed: { perplexity: 25 } }));
    expect(f.engines.find((e) => e.engine === "perplexity")).toMatchObject({
      valid: 15,
      included: false,
      geo: { level: "country", label: "Colombia" },
    });
    for (const engine of ENGINES.filter((e) => e !== "perplexity")) {
      expect(engineWeightSum(f, engine)).toBeCloseTo(0.25, 12);
    }
    expect(engineWeightSum(f, "perplexity")).toBe(0);
    expect(f.captures.filter((c) => c.engine === "perplexity")).toHaveLength(15);
  });

  test("an engine with exactly 20 valid captures stays in", () => {
    const f = buildObservations(fixture({ failed: { gemini: 20 } }));
    expect(f.engines.find((e) => e.engine === "gemini")?.included).toBe(true);
    expect(engineWeightSum(f, "gemini")).toBeCloseTo(0.2, 12);
  });

  test("five engines weigh 1/5 each and intents split their engine by demandWeight", () => {
    const [first, ...rest] = INTENTS;
    const f = buildObservations(fixture({ intentWeights: { [first as string]: 3 } }));
    expect(f.engines.map((e) => e.engine)).toEqual([...ENGINES]);
    expect(ENGINES).toContain("google-ai-mode");
    for (const engine of ENGINES) expect(engineWeightSum(f, engine)).toBeCloseTo(0.2, 12);
    const weightOf = (stratum: string) => f.captures.find((c) => c.stratum === stratum)?.weight;
    expect(weightOf(`chatgpt|${first}`)).toBeCloseTo((0.2 * 3) / 7, 12);
    expect(weightOf(`chatgpt|${rest[0]}`)).toBeCloseTo(0.2 / 7, 12);
  });

  test("a stratum without valid captures leaves and its engine renormalizes over the rest", () => {
    // The first 8 gemini slots are its whole first intent.
    const f = buildObservations(fixture({ failed: { gemini: 8 } }));
    expect(f.captures.some((c) => c.stratum === `gemini|${INTENTS[0]}`)).toBe(false);
    expect(f.captures.find((c) => c.stratum === `gemini|${INTENTS[1]}`)?.weight).toBeCloseTo(
      0.2 / 4,
      12,
    );
    const sum = [...new Map(f.captures.map((c) => [c.stratum, c.weight])).values()].reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBeCloseTo(1, 12);
  });

  test("an entity twice in one answer counts y once with the smallest ordinal", () => {
    const slot = slotOf("chatgpt", 0, 1);
    const f = buildObservations(
      fixture({
        mentions: (s) =>
          s === slot
            ? [mention({ entityKey: RIVAL, ordinal: 5 }), mention({ entityKey: RIVAL, ordinal: 2 })]
            : [],
      }),
    );
    const rival = f.entities.get(RIVAL);
    const i = indexOf(f, slot);
    expect(rival?.column.y[i]).toBe(1);
    expect(rival?.column.ordinal[i]).toBe(2);
    expect(rival?.column.y.reduce((a, b) => a + b, 0)).toBe(1);
    expect(rival).toMatchObject({ recommended: 1, incidental: 0, negative: 0 });
    expect(rival?.names.get("rival")).toBe(2);
  });

  test("a recommendation without ordinal sets y and leaves the ordinal at 0", () => {
    const slot = slotOf("gemini", 1, 3);
    const f = buildObservations(
      fixture({
        mentions: (s) => (s === slot ? [mention({ entityKey: RIVAL, ordinal: null })] : []),
      }),
    );
    const rival = f.entities.get(RIVAL);
    expect(rival?.column.y[indexOf(f, slot)]).toBe(1);
    expect(rival?.column.ordinal[indexOf(f, slot)]).toBe(0);
  });

  test("incidental and negative mentions count 0 and are reported apart", () => {
    const f = buildObservations(
      fixture({
        mentions: (s) => {
          if (s % 10 === 0)
            return [mention({ entityKey: RIVAL, stance: "incidental", ordinal: null })];
          if (s % 10 === 1)
            return [mention({ entityKey: RIVAL, stance: "negative", ordinal: null })];
          if (s % 10 === 2) return [mention({ entityKey: RIVAL, ordinal: 3 })];
          return [];
        },
      }),
    );
    const rival = f.entities.get(RIVAL);
    expect(rival).toMatchObject({ recommended: 20, incidental: 20, negative: 20, isTarget: false });
    expect(rival?.column.y.reduce((a, b) => a + b, 0)).toBe(20);
    expect(f.captures.filter((c) => c.namesEntities)).toHaveLength(60);
  });

  test("only commercial entities and platforms are kept", () => {
    const f = buildObservations(
      fixture({
        mentions: () => [
          mention({ entityKey: "chain:dentix", entityKind: "chain" }),
          mention({ entityKey: "name:abc", entityKind: "professional" }),
          mention({ entityKey: "platform:doctoralia", entityKind: "platform" }),
          mention({ entityKey: "web:revista.co", entityKind: "directory_or_media" }),
          mention({ entityKey: "web:otro.co", entityKind: "other" }),
        ],
      }),
    );
    expect([...f.entities.keys()].sort()).toEqual([
      "chain:dentix",
      "name:abc",
      "platform:doctoralia",
    ]);
    expect(f.entities.get("platform:doctoralia")?.kind).toBe("platform");
  });

  test("the target is flagged and its observations feed estimateScore on the shared frame", () => {
    const f = buildObservations(fixture());
    const target = f.entities.get(TARGET);
    expect(target?.isTarget).toBe(true);
    expect(target?.recommended).toBe(100);
    const obs = f.captures.map((c, captureIndex) => ({
      captureIndex,
      stratum: c.stratum,
      weight: c.weight,
      y: target?.column.y[captureIndex] as 0 | 1,
      ordinal: target?.column.ordinal[captureIndex] || null,
      isCanonical: c.isCanonical,
    }));
    expect(estimateScore(obs, SEED, { bootstrap: { frame: f, seed: SEED } }).value).toBe(50);
  });

  test("two succeeded captures of one slot keep the first by captureId", () => {
    const input = fixture();
    const slot = slotOf("perplexity", 2, 4);
    const original = input.captures[slot];
    if (original === undefined) throw new Error("missing slot");
    input.captures.push({ ...original, capture: { ...original.capture, id: "cap_9999" } });
    input.extractions.push({
      ...(input.extractions[slot] as (typeof input.extractions)[number]),
      captureId: "cap_9999",
      mentions: [],
    });
    const f = buildObservations({ ...input, captures: input.captures.reverse() });
    expect(f.captures).toHaveLength(200);
    expect(f.captures.some((c) => c.captureId === "cap_9999")).toBe(false);
    expect(f.engines.find((e) => e.engine === "perplexity")?.valid).toBe(40);
  });

  test("a failed attempt before a succeeded retry of the same slot does not count as failed", () => {
    const input = fixture();
    const original = input.captures[0];
    if (original === undefined) throw new Error("missing slot");
    input.captures.push({
      capture: { ...original.capture, id: "cap_0000a", status: "timeout" },
      answer: null,
    });
    const f = buildObservations(input);
    expect(f.engines.find((e) => e.engine === "chatgpt")).toMatchObject({ valid: 40, failed: 0 });
  });

  test("mixed extractor config hashes throw AppError internal", () =>
    expect(() => buildObservations(fixture({ mixedConfig: true }))).toThrow(
      expect.objectContaining({ code: "internal" }),
    ));

  test("a succeeded capture without its extraction throws AppError internal", () => {
    const input = fixture();
    expect(() => buildObservations({ ...input, extractions: input.extractions.slice(1) })).toThrow(
      expect.objectContaining({ code: "internal" }),
    );
  });

  test("a succeeded capture without an answer throws AppError internal", () => {
    const input = fixture();
    const first = input.captures[0];
    if (first === undefined) throw new Error("missing slot");
    input.captures[0] = { ...first, answer: null };
    expect(() => buildObservations(input)).toThrow(expect.objectContaining({ code: "internal" }));
  });

  test("zero valid captures throw AppError provider_unavailable", () =>
    expect(() => buildObservations(fixture({ failed: "all" }))).toThrow(
      expect.objectContaining({ code: "provider_unavailable" }),
    ));

  test("no engine with enough valid captures throws AppError provider_unavailable", () => {
    const failed = Object.fromEntries(ENGINES.map((e) => [e, 30]));
    expect(() => buildObservations(fixture({ failed }))).toThrow(
      expect.objectContaining({ code: "provider_unavailable" }),
    );
  });

  test("canonical flags and strata come from the frozen plan via slotId", () => {
    const input = fixture();
    const f = buildObservations({ ...input, captures: [...input.captures].reverse() });
    expect(f.captures[17]).toMatchObject({
      captureId: captureId(17),
      engine: "chatgpt",
      intentId: INTENTS[2],
      stratum: `chatgpt|${INTENTS[2]}`,
      isCanonical: false,
    });
    expect(f.captures[16]?.isCanonical).toBe(true);
    expect(f.captures.filter((c) => c.isCanonical)).toHaveLength(25);
  });

  test("a slot outside the plan or of another engine is refused", () => {
    const input = fixture();
    const first = input.captures[0];
    if (first === undefined) throw new Error("missing slot");
    for (const capture of [
      { ...first.capture, slotId: "m1:200" },
      { ...first.capture, slotId: "m1-0" },
      { ...first.capture, engine: "gemini" as const },
    ]) {
      input.captures[0] = { ...first, capture };
      expect(() => buildObservations(input)).toThrow(
        expect.objectContaining({ code: "validation_failed" }),
      );
    }
  });

  test("a capture of the api control channel is refused: channels never mix", () => {
    expect(() => buildObservations(fixture({ channel: { 3: "api" } }))).toThrow(
      expect.objectContaining({ code: "validation_failed" }),
    );
    expect(() => buildObservations(fixture({ channel: { 3: "ui-own" } }))).toThrow(
      expect.objectContaining({ code: "validation_failed" }),
    );
  });

  test("intent weights must be finite and positive", () => {
    for (const w of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        buildObservations(fixture({ intentWeights: { [INTENTS[0] as string]: w } })),
      ).toThrow(expect.objectContaining({ code: "validation_failed" }));
    }
  });
});
