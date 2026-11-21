import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import type { EngineAnswer } from "@reranker/capture";
import { endPools } from "@reranker/db";
import type { SpendContext } from "@reranker/jobs";
import type { ExtractedMention, MeasurementLanguage } from "@reranker/schema/measurement";
import { requireEnv } from "@reranker/testing/env";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { currentExtractorConfig, type ExtractorConfig } from "../src/config";
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

// Accuracy is what is measured: the production deadlines would turn a slow call into a missing
// answer, and the latency each language takes is reported apart.
const config: ExtractorConfig = {
  ...currentExtractorConfig,
  timeoutsMs: { ...currentExtractorConfig.timeoutsMs, extract: 60_000, judge: 60_000 },
};

beforeAll(() => {
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
  vi.stubEnv("OPENAI_API_KEY", requireEnv("OPENAI_API_KEY_CI"));
  vi.stubEnv("GEMINI_API_KEY", requireEnv("GEMINI_API_KEY_CI"));
  // Professionals named in the answers are keyed by HMAC; any key scores the same.
  vi.stubEnv("ENTITY_NAME_HMAC_KEY", randomBytes(32).toString("base64url"));
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
  slowestMs: number;
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
  slowestMs: 0,
});

/** Scores one answer and returns what it got wrong, for the log. */
function score(t: Tally, mentions: ExtractedMention[], e: Expected): string[] {
  const misses: string[] = [];
  t.answers++;
  const recommendations = mentions.filter((m) => m.stance === "recommendation");
  const ordinals: number[] = [];
  for (const name of e.recommended) {
    t.recommended++;
    const m = find(recommendations, name);
    if (m) {
      t.recommendedFound++;
      ordinals.push(m.ordinal ?? Number.POSITIVE_INFINITY);
    } else
      misses.push(`recommended not found: ${name} (${find(mentions, name)?.stance ?? "absent"})`);
  }
  for (let i = 1; i < ordinals.length; i++) {
    t.pairs++;
    if ((ordinals[i - 1] as number) < (ordinals[i] as number)) t.pairsInOrder++;
    else misses.push(`out of order: ordinals ${ordinals.join(", ")}`);
  }
  t.recommendations += recommendations.length;
  for (const m of recommendations) {
    if (e.recommended.some((name) => same(m.name, name))) t.recommendationsExpected++;
    else misses.push(`recommended in excess: ${m.name}`);
  }
  for (const name of e.negative) {
    t.negative++;
    const stance = find(mentions, name)?.stance;
    if (stance === "negative") t.negativeFound++;
    else misses.push(`negative missed: ${name} (${stance ?? "absent"})`);
  }
  for (const name of e.incidental) {
    t.incidental++;
    const m = find(mentions, name);
    if (m && m.stance !== "recommendation") t.incidentalFound++;
    else misses.push(`incidental missed: ${name} (${m?.stance ?? "absent"})`);
  }
  return misses;
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
    const result = await extractResponse(raw, { spend }, { config });
    const t = tallies.get(e.language) ?? empty();
    tallies.set(e.language, t);
    t.slowestMs = Math.max(t.slowestMs, result.latencyMs);
    const misses = score(t, result.mentions, e);
    if (misses.length > 0) console.log(`${id} (${result.agreement}):\n  ${misses.join("\n  ")}`);
  });

  const rows = [...tallies.entries()].sort(([a], [b]) => a.localeCompare(b));
  const table = [
    "| language | answers | recommended recall | recommendation precision | order | negative recall | incidental recall | slowest |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map(
      ([language, t]) =>
        `| ${language} | ${t.answers} | ${pct(rate(t.recommendedFound, t.recommended))} | ${pct(
          rate(t.recommendationsExpected, t.recommendations),
        )} | ${pct(rate(t.pairsInOrder, t.pairs))} | ${pct(rate(t.negativeFound, t.negative))} | ${pct(
          rate(t.incidentalFound, t.incidental),
        )} | ${(t.slowestMs / 1000).toFixed(1)} s |`,
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
