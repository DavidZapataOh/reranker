import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MeasurementPlan } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import { reviveVector, VECTOR_NAMES, type Vector } from "../scripts/vectors";
import { jeffreys, wilson } from "../src/interval";
import { methodology, seedFor } from "../src/methodology";
import { computeFreeReportStats } from "../src/report";
import intervals from "../test-vectors/intervals.json" with { type: "json" };

const dir = fileURLToPath(new URL("../test-vectors/reports/", import.meta.url));
const listVectors = () => readdirSync(dir).filter((f) => f.endsWith(".json"));
const read = (file: string): Vector => JSON.parse(readFileSync(`${dir}${file}`, "utf8"));

// Each vector runs a full report with its Monte Carlo ranges, too slow under coverage.
describe("report vectors", () => {
  test("the shared set is exactly the published one", () => {
    expect(listVectors().sort()).toEqual(VECTOR_NAMES.map((n) => `${n}.json`).sort());
  });

  test.each(VECTOR_NAMES.map((n) => `${n}.json`))("%s reproduces byte for byte", (file) => {
    const v = read(file);
    expect(v.methodologyVersion).toBe(methodology.version);
    expect(v.methodologyHash).toBe(methodology.hash);
    expect(MeasurementPlan.safeParse(v.input.plan).success).toBe(true);
    expect(v.output.seed).toBe(seedFor(v.input.reportId, v.methodologyHash));
    expect(JSON.stringify(computeFreeReportStats(reviveVector(v.input)))).toBe(
      JSON.stringify(v.output),
    );
  });
});

// The V2 service is held to 1e-9 against SciPy; so is this implementation, with the same
// y = 0 and y = n endpoint convention.
describe("interval vectors", () => {
  const within = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-9);

  test.each(intervals.jeffreys)("jeffreys($y, $n) at $level", ({ y, n, level, lower, upper }) => {
    const r = jeffreys(y, n, level);
    within(r.lower, y === 0 ? 0 : lower);
    within(r.upper, y === n ? 1 : upper);
  });

  test.each(intervals.wilson)("wilson($y, $n) at $level", ({ y, n, level, lower, upper }) => {
    const r = wilson(y, n, level);
    within(r.lower, lower);
    within(r.upper, upper);
  });
});
