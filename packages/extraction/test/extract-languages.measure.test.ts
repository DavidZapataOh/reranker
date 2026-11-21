import { randomUUID } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import type { EngineAnswer } from "@reranker/capture";
import { endPools } from "@reranker/db";
import type { SpendContext } from "@reranker/jobs";
import type { ExtractedMention, MeasurementLanguage } from "@reranker/schema/measurement";
import { requireEnv } from "@reranker/testing/env";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { extractResponse, type RawCapture } from "../src/extract";
import { jaroWinkler, normalizeName, tokenContainment } from "../src/normalize";

// Storage is not what is measured: extractions are neither looked up nor kept.
vi.mock("../src/store", () => ({
  findExtraction: async () => null,
  insertExtraction: async () => ({ id: "measured", inserted: true }),
}));
vi.mock("@reranker/evidence", () => ({
  putArtifact: async () => ({ sha256: "0".repeat(64), created: true }),
  getArtifact: async () => null,
}));
vi.mock("@reranker/flags", () => ({ isEnabled: async () => true }));

const DIR = new URL("fixtures/answers/languages/", import.meta.url);

/** What a reader checks by hand in each answer, names as written in it. */
interface Expected {
  language: MeasurementLanguage;
  /** Offered as options, in the order the answer gives them. */
  recommended: string[];
  /** Warned against. */
  negative: string[];
  /** Named only as a source, reference or platform. */
  incidental: string[];
}

const expected = JSON.parse(readFileSync(new URL("expected.json", DIR), "utf8")) as Record<
  string,
  Expected
>;
const answers = readdirSync(DIR)
  .filter((file) => file !== "expected.json")
  .map((file) => ({
    id: file.replace(/\.json$/, ""),
    answer: JSON.parse(readFileSync(new URL(file, DIR), "utf8")) as EngineAnswer,
  }));

const spend: SpendContext = {
  purpose: "contract-test",
  refType: "extraction-languages",
  refId: randomUUID(),
};

beforeAll(() => {
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
  vi.stubEnv("OPENAI_API_KEY", requireEnv("OPENAI_API_KEY_CI"));
  vi.stubEnv("GEMINI_API_KEY", requireEnv("GEMINI_API_KEY_CI"));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await endPools();
});

const same = (a: string, b: string) => {
  const x = normalizeName(a, "business");
  const y = normalizeName(b, "business");
  return jaroWinkler(x, y) >= 0.92 || tokenContainment(x, y) || tokenContainment(y, x);
};
const find = (mentions: ExtractedMention[], name: string) =>
  mentions.find((m) => same(m.name, name));

interface Tally {
  answers: number;
  recommended: number;
  recommendedFound: number;
  recommendations: number;
  recommendationsExpected: number;
  pairs: number;
  pairsInOrder: number;
  negative: number;
  negativeFound: number;
  incidental: number;
  incidentalFound: number;
}

const empty = (): Tally => ({
  answers: 0,
  recommended: 0,
  recommendedFound: 0,
  recommendations: 0,
  recommendationsExpected: 0,
  pairs: 0,
  pairsInOrder: 0,
  negative: 0,
  negativeFound: 0,
  incidental: 0,
  incidentalFound: 0,
});

function score(t: Tally, mentions: ExtractedMention[], e: Expected): void {
  t.answers++;
  const recommendations = mentions.filter((m) => m.stance === "recommendation");
  const ordinals: number[] = [];
  for (const name of e.recommended) {
    t.recommended++;
    const m = find(recommendations, name);
    if (m) {
      t.recommendedFound++;
      ordinals.push(m.ordinal ?? Number.POSITIVE_INFINITY);
    }
  }
  for (let i = 1; i < ordinals.length; i++) {
    t.pairs++;
    if ((ordinals[i - 1] as number) < (ordinals[i] as number)) t.pairsInOrder++;
  }
  t.recommendations += recommendations.length;
  t.recommendationsExpected += recommendations.filter((m) =>
    e.recommended.some((name) => same(m.name, name)),
  ).length;
  for (const name of e.negative) {
    t.negative++;
    if (find(mentions, name)?.stance === "negative") t.negativeFound++;
  }
  for (const name of e.incidental) {
    t.incidental++;
    const m = find(mentions, name);
    if (m && m.stance !== "recommendation") t.incidentalFound++;
  }
}

// Each extraction holds leases on two providers and the judge's: past a pool's slots a caller
// waits longer than the inline wait and is turned away.
const LANES = 4;

async function inLanes<T>(items: readonly T[], work: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      await work(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LANES, items.length) }, lane));
}

const rate = (n: number, d: number) => (d === 0 ? null : n / d);
const pct = (r: number | null) => (r === null ? "–" : `${(r * 100).toFixed(1)} %`);

// One extraction per recorded answer with the production pair and judge, a few US cents in all.
test("extraction finds, orders and judges entities in every measurement language", async () => {
  const tallies = new Map<MeasurementLanguage, Tally>();
  await inLanes(answers, async ({ id, answer }, i) => {
    const e = expected[id];
    if (!e) throw new Error(`${id} has no expectation`);
    const raw: RawCapture = {
      capture: {
        id: `cap_measure_${i}`,
        engine: answer.engine,
        channel: answer.channel,
        status: "succeeded",
        modelReported: answer.modelReported,
        slotId: `slot-measure-${i}`,
      },
      answer,
    } as RawCapture;
    const result = await extractResponse(raw, { spend });
    const t = tallies.get(e.language) ?? empty();
    tallies.set(e.language, t);
    score(t, result.mentions, e);
  });

  const rows = [...tallies.entries()].sort(([a], [b]) => a.localeCompare(b));
  const table = [
    "| language | answers | recommended recall | recommendation precision | order | negative recall | incidental recall |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      ([language, t]) =>
        `| ${language} | ${t.answers} | ${pct(rate(t.recommendedFound, t.recommended))} | ${pct(
          rate(t.recommendationsExpected, t.recommendations),
        )} | ${pct(rate(t.pairsInOrder, t.pairs))} | ${pct(rate(t.negativeFound, t.negative))} | ${pct(
          rate(t.incidentalFound, t.incidental),
        )} |`,
    ),
  ].join("\n");
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);

  for (const [language, t] of rows) {
    expect(rate(t.recommendedFound, t.recommended), `${language} recall`).toBeGreaterThanOrEqual(
      0.9,
    );
    expect(
      rate(t.recommendationsExpected, t.recommendations),
      `${language} precision`,
    ).toBeGreaterThanOrEqual(0.9);
    expect(rate(t.pairsInOrder, t.pairs) ?? 1, `${language} order`).toBeGreaterThanOrEqual(0.95);
    expect(rate(t.negativeFound, t.negative) ?? 1, `${language} negatives`).toBeGreaterThanOrEqual(
      0.8,
    );
  }
}, 600_000);
