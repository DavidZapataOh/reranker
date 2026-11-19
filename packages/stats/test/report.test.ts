import type { EngineId } from "@reranker/schema";
import { describe, expect, test } from "vitest";
import { computeFreeReportStats } from "../src/report";
import { ENGINES, reportInput as inputOf, mention, RIVAL, TARGET } from "./fixtures/report-200";

describe("computeFreeReportStats", () => {
  test("byEngine of the target carries score and counts, excluded engines included", () => {
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
      geo: { level: "country", label: "Colombia" },
    });
  });

  test("edge: one engine only", () => {
    const failed = Object.fromEntries(
      ENGINES.filter((e) => e !== "gemini").map((e) => [e, 40]),
    ) as Partial<Record<EngineId, number>>;
    const stats = computeFreeReportStats(inputOf({ failed }));
    expect(stats.target.overall).toMatchObject({ value: 50 });
    expect(stats.engines.filter((e) => e.included).map((e) => e.engine)).toEqual(["gemini"]);
    expect(stats.engines.find((e) => e.engine === "chatgpt")?.namesEntitiesRate).toBeNull();
    expect(stats.target.byEngine.chatgpt).toBeUndefined();
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
    expect(stats.rankingGroups).toEqual([[TARGET]]);
    expect(stats.engines.every((e) => e.namesEntitiesRate?.estimate === 0)).toBe(true);
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
  });

  test("displayName is the most frequent surface form, never the input name", () => {
    const stats = computeFreeReportStats(
      inputOf({
        mentions: (slot) => [
          mention({ entityKey: TARGET, name: slot % 3 === 0 ? "SONRISAS SAS" : "Sonrisas" }),
        ],
      }),
    );
    expect(stats.target.displayName).toBe("Sonrisas");
  });
});
