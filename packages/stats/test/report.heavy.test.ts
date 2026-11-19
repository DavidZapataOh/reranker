import type { FreeReportStats, MeasurementPlan } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import { methodology, seedFor } from "../src/methodology";
import { computeFreeReportStats } from "../src/report";
import { reportInput as inputOf, ladder, plan, REPORT } from "./fixtures/report-200";

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
