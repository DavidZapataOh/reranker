import type { FreeReportStats, MeasurementPlan } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import { methodology, seedFor } from "../src/methodology";
import { computeFreeReportStats, toFreeReportSummary } from "../src/report";
import {
  reportInput as inputOf,
  ladder,
  mention,
  plan,
  REPORT,
  rival,
  TARGET,
} from "./fixtures/report-200";

// Each report runs its Monte Carlo ranges and the shared bootstrap, too slow under coverage.
describe("computeFreeReportStats", () => {
  test("criterion 4: same input, byte-identical JSON; the seed binds report and methodology", () => {
    const input = inputOf({ mentions: ladder });
    const stats = computeFreeReportStats(input);
    expect(JSON.stringify(computeFreeReportStats(structuredClone(input)))).toBe(
      JSON.stringify(stats),
    );
    expect(stats.seed).toBe(seedFor(REPORT, methodology.hash));
    expect(seedFor(REPORT, "x".repeat(64))).not.toBe(stats.seed);
    expect(computeFreeReportStats({ ...input, reportId: "fr_other" }).seed).not.toBe(stats.seed);
    expect(stats).toMatchObject({
      methodologyVersion: methodology.version,
      methodologyHash: methodology.hash,
      intentSetId: plan.intentSet.id,
      intentSetHash: plan.intentSet.contentHash,
      extractorConfigHash: "f".repeat(64),
      computedAt: "2026-11-19T15:00:00.000Z",
    });
  });

  test("competitors are the top 5 commercial entities by pointValue, target excluded", () => {
    const stats = computeFreeReportStats(
      inputOf({
        mentions: (slot) => [
          ...ladder(slot),
          mention({ entityKey: "platform:booking", entityKind: "platform", ordinal: null }),
          mention({ entityKey: "web:directorio.co", entityKind: "directory_or_media" }),
        ],
      }),
    );
    expect(stats.competitors.map((c) => c.entityKey)).toEqual([0, 1, 2, 3, 4].map(rival));
    const values = stats.competitors.map((c) => c.pointValue);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(stats.competitors.every((c) => !c.isTarget && c.overall !== null)).toBe(true);
    expect(stats.comparisons.map((c) => [c.a, c.b])).toEqual(
      [0, 1, 2, 3, 4].map((k) => [TARGET, rival(k)]),
    );
    expect(stats.rankingGroups.flat().sort()).toEqual(
      [TARGET, ...[0, 1, 2, 3, 4].map(rival)].sort(),
    );
    expect(stats.rankingGroups[0]).toContain(TARGET);
  });

  test("full intervals for target + top 10 by recommendations; the rest only pointValue", () => {
    // Ten rivals in 40 answers at rank 10 (≈ 8 points) and one in 20 answers at rank 1 (10 points).
    const stats = computeFreeReportStats(
      inputOf({
        mentions: (slot) => [
          ...(slot % 10 === 1 ? [mention({ entityKey: "place:sharp" })] : []),
          ...(slot % 5 === 0
            ? Array.from({ length: 10 }, (_, k) =>
                mention({ entityKey: `place:many${k}`, ordinal: 10 }),
              )
            : []),
        ],
      }),
    );
    const [sharp, ...rest] = stats.competitors;
    expect(sharp).toMatchObject({ entityKey: "place:sharp", overall: null, pointValue: 10 });
    expect(rest.map((c) => c.entityKey)).toEqual([
      "place:many0",
      "place:many1",
      "place:many2",
      "place:many3",
    ]);
    expect(rest.every((c) => c.overall !== null && c.overall.value === c.pointValue)).toBe(true);
    expect(toFreeReportSummary(stats).topCompetitors[0]).toMatchObject({ value: 10 });
  });

  test("canonicalOnly uses only canonical observations (25)", () => {
    const stats = computeFreeReportStats(inputOf({ mentions: ladder }));
    expect(stats.canonicalOnly?.target.components.recommendationRate.trials).toBe(25);
    expect(stats.canonicalOnly?.competitors.map((c) => c.entityKey)).toEqual(
      stats.competitors.map((c) => c.entityKey),
    );
    expect(stats.target.overall?.components.recommendationRate.trials).toBe(200);
  });

  test("intents carry the target score, its counts and the rate of answers naming businesses", () => {
    const stats = computeFreeReportStats(inputOf({ notPresent: { gemini: 8 } }));
    expect(stats.intents).toHaveLength(5);
    expect(stats.intents[0]).toMatchObject({
      intentId: plan.observations[0]?.intentId,
      targetCounts: { recommended: 16, validCaptures: 40 },
      targetScore: { components: { recommendationRate: { trials: 40 } } },
    });
    expect(stats.intents[0]?.namesEntitiesRate.estimate).toBeCloseTo(0.8, 12);
    expect(
      stats.engines.find((e) => e.engine === "gemini")?.namesEntitiesRate?.estimate,
    ).toBeCloseTo(0.8, 12);
  });

  test("criterion 11: national generated and template plans change only set ids, hashes and labels", () => {
    const relabel = (kind: "generated" | "template", id: `is_${string}`): MeasurementPlan => ({
      ...plan,
      intentSet: { ...plan.intentSet, id, kind, scope: "national", contentHash: "9".repeat(64) },
      scope: "national",
      geo: { ...plan.geo, key: "co", level: "country", name: "Colombia", regionName: null },
      observations: plan.observations.map((o) => ({
        ...o,
        intentSetId: id,
        geoKey: "co",
        geoDeclared: { level: "country", label: "Colombia" },
      })),
    });
    const strip = (s: FreeReportStats) => ({
      ...s,
      intentSetId: null,
      intentSetHash: null,
      engines: s.engines.map((e) => ({ ...e, geo: null })),
    });
    const seed = computeFreeReportStats(inputOf({ mentions: ladder }));
    for (const [kind, id] of [
      ["generated", "is_aaaaaaaaaaaaaaaa"],
      ["template", "is_bbbbbbbbbbbbbbbb"],
    ] as const) {
      const other = computeFreeReportStats({
        ...inputOf({ mentions: ladder }),
        plan: relabel(kind, id),
      });
      expect(other).toMatchObject({ intentSetId: id, intentSetHash: "9".repeat(64) });
      expect(other.engines.every((e) => e.geo.level === "country")).toBe(true);
      expect(strip(other)).toEqual(strip(seed));
    }
  });
});

describe("toFreeReportSummary", () => {
  test("carries the target range, verdicts and preliminary", () => {
    const stats = computeFreeReportStats(inputOf({ mentions: ladder }));
    const summary = toFreeReportSummary(stats);
    const { value, lower, upper, atMost, level, levelDisplay, sufficiency } = stats.target
      .overall as NonNullable<FreeReportStats["target"]["overall"]>;
    expect(summary).toMatchObject({
      methodologyHash: methodology.hash,
      preliminary: true,
      target: { value, lower, upper, atMost, level, levelDisplay, sufficiency },
    });
    expect(summary.topCompetitors.map((c) => [c.entityKey, c.verdict])).toEqual(
      stats.comparisons.map((c) => [c.b, c.verdict]),
    );
  });

  // Five engines and five competitors take ~1.25 KB of JSON before any name (1.6 KB with these),
  // so the summary is bounded at 2 KB: still well inside the report row's 3 KB.
  test("stays within 2 KB with five long competitor names cut to 60 characters", () => {
    const long = "Clínica Odontológica Integral de Especialistas en Ortodoncia y Diseño de Sonrisa";
    const stats = computeFreeReportStats(
      inputOf({
        mentions: (slot) => [
          ...ladder(slot).map((m) => ({ ...m, name: `${long} ${m.entityKey}` })),
        ],
      }),
    );
    const summary = toFreeReportSummary(stats);
    expect(summary.topCompetitors).toHaveLength(5);
    expect(summary.topCompetitors.every((c) => [...c.displayName].length === 60)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(2048);
  });
});
