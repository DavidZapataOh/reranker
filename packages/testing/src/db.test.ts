import { expect, it, vi } from "vitest";
import indexScanPlan from "./__fixtures__/plans/index-scan.json" with { type: "json" };
import nestedSeqScanPlan from "./__fixtures__/plans/nested-seq-scan.json" with { type: "json" };
import seqScanOnOtherTablePlan from "./__fixtures__/plans/seq-scan-other-table.json" with {
  type: "json",
};
import { type ExplainPlan, expectNoSeqScanOn, explain } from "./db.ts";

const nested = nestedSeqScanPlan as unknown as ExplainPlan;
const indexed = indexScanPlan as unknown as ExplainPlan;
const other = seqScanOnOtherTablePlan as unknown as ExplainPlan;

it("finds a Seq Scan nested under joins", () => {
  expect(() => expectNoSeqScanOn(nested, "isolation_probe")).toThrow(
    'Seq Scan on "isolation_probe"',
  );
});

it("passes on Index Scan and ignores Seq Scans on other tables", () => {
  expect(() => expectNoSeqScanOn(indexed, "isolation_probe")).not.toThrow();
  expect(() => expectNoSeqScanOn(other, "isolation_probe")).not.toThrow();
});

it("matches schema-qualified relation names", () => {
  expect(() => expectNoSeqScanOn(nested, "app.isolation_probe")).toThrow();
  expect(() => expectNoSeqScanOn(nested, "public.isolation_probe")).not.toThrow();
});

it("runs EXPLAIN and unwraps the first plan", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ "QUERY PLAN": [indexed] }] });
  expect(await explain({ query } as never, "select 1 where $1", [1])).toBe(indexed);
  expect(query).toHaveBeenCalledWith(
    "EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) select 1 where $1",
    [1],
  );
});
