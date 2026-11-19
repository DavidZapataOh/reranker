import type { EngineId } from "@reranker/schema";
import { describe, expect, test } from "vitest";
import { computeFreeReportStats, toFreeReportSummary } from "../src/report";
import { ENGINES, reportInput as inputOf, mention, RIVAL, TARGET } from "./fixtures/report-200";

describe("computeFreeReportStats", () => {
  test("byEngine of the target carries score and counts; excluded engines are few_data in the summary", () => {
    const stats = computeFreeReportStats(inputOf({ failed: { perplexity: 25 } }));
    for (const engine of ENGINES.filter((e) => e !== "perplexity")) {
      expect(stats.target.byEngine[engine]).toMatchObject({
        score: { value: 50 },
        counts: { recommended: 20, incidental: 0, negative: 0, validCaptures: 40 },
      });
    }
    expect(stats.target.byEngine.perplexity?.counts).toMatchObject({ validCaptures: 15 });
    expect(stats.engines.find((e) => e.engine === "perplexity")).toMatchObject({
      included: false,
      valid: 15,
      failed: 25,
    });
    const summary = toFreeReportSummary(stats);
    expect(summary.engines.find((e) => e.engine === "perplexity")).toMatchObject({
      status: "few_data",
      valid: 15,
      geo: { level: "country", label: "Colombia" },
    });
    expect(summary.engines.find((e) => e.engine === "chatgpt")).toMatchObject({
      status: "on_the_list",
      recommended: 20,
      valid: 40,
    });
  });

  test("platforms report their recommended share and never compete", () => {
    const stats = computeFreeReportStats(
      inputOf({
        mentions: (slot) => [
          mention({ entityKey: RIVAL }),
          ...(slot % 4 === 0
            ? [mention({ entityKey: "platform:booking", entityKind: "platform", ordinal: null })]
            : []),
        ],
      }),
    );
    expect(stats.platforms).toHaveLength(1);
    expect(stats.platforms[0]).toMatchObject({
      entityKey: "platform:booking",
      displayName: "booking",
    });
    expect(stats.platforms[0]?.recommendedShare.estimate).toBeCloseTo(0.25, 12);
    expect(stats.competitors.map((c) => c.entityKey)).toEqual([RIVAL]);
  });

  test("edge: one engine only", () => {
    const failed = Object.fromEntries(
      ENGINES.filter((e) => e !== "gemini").map((e) => [e, 40]),
    ) as Partial<Record<EngineId, number>>;
    const stats = computeFreeReportStats(inputOf({ failed }));
    expect(stats.target.overall).toMatchObject({ value: 50 });
    expect(stats.engines.filter((e) => e.included).map((e) => e.engine)).toEqual(["gemini"]);
    expect(stats.engines.find((e) => e.engine === "chatgpt")?.namesEntitiesRate).toBeNull();
    const summary = toFreeReportSummary(stats);
    expect(summary.engines.filter((e) => e.status === "few_data")).toHaveLength(4);
    expect(summary.engines.find((e) => e.engine === "chatgpt")).toMatchObject({
      recommended: 0,
      valid: 0,
    });
  });

  test("edge: no answer names a business", () => {
    const stats = computeFreeReportStats(inputOf({ mentions: () => [] }));
    expect(stats.target).toMatchObject({
      entityKey: TARGET,
      displayName: "Clínica Sonrisas",
      entityKind: "business",
      pointValue: 0,
      overall: { value: 0, lower: 0, level: "invisible" },
      counts: { recommended: 0, validCaptures: 200 },
    });
    expect(stats.target.overall?.atMost).toBe(stats.target.overall?.upper);
    expect(stats.competitors).toEqual([]);
    expect(stats.platforms).toEqual([]);
    expect(stats.rankingGroups).toEqual([[TARGET]]);
    expect(stats.engines.every((e) => e.namesEntitiesRate?.estimate === 0)).toBe(true);
    expect(toFreeReportSummary(stats).topCompetitors).toEqual([]);
  });

  test("edge: the target is only mentioned in passing", () => {
    const stats = computeFreeReportStats(
      inputOf({
        mentions: () => [
          mention({ entityKey: TARGET, stance: "incidental", ordinal: null }),
          mention({ entityKey: RIVAL }),
        ],
      }),
    );
    expect(stats.target.overall).toMatchObject({ value: 0, level: "invisible" });
    expect(Number.isFinite(stats.target.overall?.upper)).toBe(true);
    expect(stats.target.counts).toEqual({
      recommended: 0,
      incidental: 200,
      negative: 0,
      validCaptures: 200,
    });
    expect(stats.comparisons).toEqual([{ a: TARGET, b: RIVAL, pAAhead: 0, verdict: "behind" }]);
  });

  test("displayName is the most frequent surface form, never the input name", () => {
    const stats = computeFreeReportStats(
      inputOf({
        mentions: (slot) => [
          mention({ entityKey: TARGET, name: slot % 3 === 0 ? "SONRISAS SAS" : "Sonrisas" }),
          mention({
            entityKey: RIVAL,
            name: slot % 3 === 0 ? "Dental Rival" : "Rival",
            ordinal: 2,
          }),
        ],
      }),
    );
    expect(stats.target.displayName).toBe("Sonrisas");
    expect(stats.competitors[0]?.displayName).toBe("Rival");
  });

  test("a mention flagged as the target under another key is never a competitor", () => {
    const stats = computeFreeReportStats(
      inputOf({
        mentions: () => [
          mention({ entityKey: TARGET }),
          mention({ entityKey: "name:sonrisas@co-c1003654", isTarget: true, ordinal: 2 }),
          mention({ entityKey: RIVAL, ordinal: 3 }),
        ],
      }),
    );
    expect(stats.competitors.map((c) => c.entityKey)).toEqual([RIVAL]);
  });
});

describe("toFreeReportSummary", () => {
  test("throws when the target has no range or a competitor was not compared", () => {
    const stats = computeFreeReportStats(inputOf());
    expect(() =>
      toFreeReportSummary({ ...stats, target: { ...stats.target, overall: null } }),
    ).toThrow(/no score range/);
    expect(() => toFreeReportSummary({ ...stats, comparisons: [] })).toThrow(/was not compared/);
  });
});
