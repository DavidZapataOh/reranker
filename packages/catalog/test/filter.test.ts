import type { ParaphraseFormat } from "@reranker/schema/measurement";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { cosine, selectPool } from "../src/generate/filter";
import type { Candidate } from "../src/generate/guards";

const v = (...xs: number[]) => Float32Array.from(xs);

function candidate(text: string, format: ParaphraseFormat = "open_question"): Candidate {
  return { text, format, generator: "openai" };
}

// A unit vector at `deg` degrees from the x axis: its cosine to the axis is cos(deg).
function at(deg: number) {
  const r = (deg * Math.PI) / 180;
  return v(Math.cos(r), Math.sin(r));
}

// The shared axis plus `spread` along an axis of its own: spokes at spread 1 are 0.5 apart, so none
// dedupes, and a smaller spread sits closer to the centroid.
function spoke(i: number, spread: number) {
  const out = new Float32Array(64);
  out[0] = 1;
  out[i + 1] = spread;
  return out;
}

describe("cosine", () => {
  test("is scale invariant and bounded", () => {
    expect(cosine(v(1, 0), v(5, 0))).toBeCloseTo(1);
    expect(cosine(v(1, 0), v(0, 3))).toBeCloseTo(0);
    expect(cosine(v(1, 1), v(-1, -1))).toBeCloseTo(-1);
  });

  test("a zero vector is similar to nothing", () => {
    expect(cosine(v(0, 0), v(1, 0))).toBe(0);
  });

  test("vectors of different dimensions are a programming error", () => {
    expect(() => cosine(v(1, 0), v(1, 0, 0))).toThrow();
  });
});

describe("selectPool", () => {
  test("dedupe drops pairs at cosine ≥ 0.90 and keeps the one closer to the centroid", () => {
    // d sits on the centroid; a and b are within 20° of it (cos ≥ 0.94), c is 30° away (cos 0.87).
    const out = selectPool({
      candidates: [candidate("a"), candidate("b"), candidate("c"), candidate("d")],
      embeddings: [at(20), at(5), at(-30), at(0)],
      judged: [true, true, true, true],
      keep: 12,
      minPerFormat: 0,
    });
    expect(out.kept.map((c) => c.text)).toEqual(["d", "c"]);
    expect(out.report).toEqual({ dedupe: 2, offCentroid: 0, judge: 0, quota: 0 });
  });

  test("a judge-rejected paraphrase never knocks out its accepted twin", () => {
    const out = selectPool({
      candidates: [candidate("rejected"), candidate("twin"), candidate("other")],
      embeddings: [at(0), at(5), at(-30)],
      judged: [false, true, true],
      keep: 12,
      minPerFormat: 0,
    });
    expect(out.kept.map((c) => c.text)).toEqual(["twin", "other"]);
    expect(out.report).toEqual({ dedupe: 0, offCentroid: 0, judge: 1, quota: 0 });
  });

  test("just under 0.90 both stay", () => {
    const deg = (Math.acos(0.899) * 180) / Math.PI;
    const out = selectPool({
      candidates: [candidate("a"), candidate("b")],
      embeddings: [at(deg / 2), at(-deg / 2)],
      judged: [true, true],
      keep: 12,
      minPerFormat: 0,
    });
    expect(out.kept).toHaveLength(2);
  });

  test("off-centroid (< 0.60) and judge-rejected candidates are dropped and counted", () => {
    const out = selectPool({
      candidates: ["a", "b", "c", "far", "rejected"].map((t) => candidate(t)),
      embeddings: [spoke(0, 0.5), spoke(1, 0.6), spoke(2, 0.7), spoke(3, 3), spoke(4, 0.55)],
      judged: [true, true, true, true, false],
      keep: 12,
      minPerFormat: 0,
    });
    expect(out.kept.map((c) => c.text)).toEqual(["a", "b", "c"]);
    expect(out.report).toEqual({ dedupe: 0, offCentroid: 1, judge: 1, quota: 0 });
  });

  test("top 12 respects at least 2 per format when available", () => {
    // 16 open questions closest to the centroid, then 2 keywords and 1 constraint further out.
    const formats: ParaphraseFormat[] = [
      ...Array<ParaphraseFormat>(16).fill("open_question"),
      "keyword",
      "keyword",
      "constraint",
    ];
    const out = selectPool({
      candidates: formats.map((f, i) => candidate(`t${i}`, f)),
      embeddings: formats.map((_, i) => spoke(i, 0.8 + 0.02 * i)),
      judged: formats.map(() => true),
      keep: 12,
      minPerFormat: 2,
    });
    const count = (f: ParaphraseFormat) => out.kept.filter((c) => c.format === f).length;
    expect(out.kept).toHaveLength(12);
    expect([count("keyword"), count("constraint"), count("list_request")]).toEqual([2, 1, 0]);
    expect(count("open_question")).toBe(9);
    expect(out.report.quota).toBe(7);
    // The open questions kept are the nine closest to the centroid.
    expect(out.kept.filter((c) => c.format === "open_question").map((c) => c.text)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
      "t7",
      "t8",
    ]);
  });

  test("guards reject everything → empty pool, never throws", () => {
    const allRejected = {
      candidates: ["a", "b"].map((t) => candidate(t)),
      embeddings: [at(0), at(10)],
      judged: [false, false],
      keep: 12,
      minPerFormat: 2,
    };
    expect(selectPool(allRejected).kept).toEqual([]);
    expect(selectPool({ ...allRejected, candidates: [], embeddings: [], judged: [] }).kept).toEqual(
      [],
    );
  });

  test("inputs of different lengths are a programming error", () => {
    expect(() =>
      selectPool({
        candidates: [candidate("a")],
        embeddings: [],
        judged: [true],
        keep: 1,
        minPerFormat: 0,
      }),
    ).toThrow();
  });

  test("every candidate is either kept or counted once, and nothing kept is a near duplicate", () => {
    const formats = ["open_question", "list_request", "keyword", "constraint"] as const;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            vector: fc.array(fc.integer({ min: -3, max: 3 }), { minLength: 3, maxLength: 3 }),
            judged: fc.boolean(),
            format: fc.constantFrom(...formats),
          }),
          { maxLength: 30 },
        ),
        fc.integer({ min: 0, max: 14 }),
        fc.integer({ min: 0, max: 3 }),
        (rows, keep, minPerFormat) => {
          const out = selectPool({
            candidates: rows.map((r, i) => candidate(`t${i}`, r.format)),
            embeddings: rows.map((r) => v(...r.vector)),
            judged: rows.map((r) => r.judged),
            keep,
            minPerFormat,
          });
          const { dedupe, offCentroid, judge, quota } = out.report;
          expect(out.kept.length + dedupe + offCentroid + judge + quota).toBe(rows.length);
          expect(out.kept.length).toBeLessThanOrEqual(keep);
          const kept = out.kept.map((c) => v(...(rows[Number(c.text.slice(1))]?.vector ?? [])));
          for (let i = 0; i < kept.length; i++) {
            for (let j = i + 1; j < kept.length; j++) {
              expect(cosine(kept[i] as Float32Array, kept[j] as Float32Array)).toBeLessThan(0.9);
            }
          }
        },
      ),
    );
  });
});
