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
import { EXTRACT_PROMPT_V3 } from "../src/prompts/extract.v3";
import type { MentionsOutput } from "../src/schema";

// Storage is not what is measured: extractions are neither looked up nor kept.
type CallRecord = { model: string; output: MentionsOutput | null };
interface StoredOutputs {
  captureId: string;
  primary: CallRecord;
  secondary: CallRecord | null;
  judge: CallRecord | null;
  quoteMisses: { primary: number; secondary: number; judge: number };
}

// What each extraction would have stored, kept to explain its misses and its token use.
const stored = vi.hoisted(() => ({
  outputs: new Map<string, StoredOutputs>(),
  inputTokens: new Map<string, number>(),
  outputTokens: new Map<string, number>(),
}));
vi.mock("../src/store", () => ({
  findExtraction: async () => null,
  insertExtraction: async (row: {
    captureId: string;
    inputTokens: number;
    outputTokens: number;
  }) => {
    stored.inputTokens.set(row.captureId, row.inputTokens);
    stored.outputTokens.set(row.captureId, row.outputTokens);
    return { id: "measured", inserted: true };
  },
}));
vi.mock("@reranker/evidence", () => ({
  putArtifact: async (_kind: string, bytes: Uint8Array) => {
    const outputs = JSON.parse(new TextDecoder().decode(bytes)) as StoredOutputs;
    stored.outputs.set(outputs.captureId, outputs);
    return { sha256: "0".repeat(64), created: true };
  },
  getArtifact: async () => null,
}));
vi.mock("@reranker/flags", () => ({ isEnabled: async () => true }));
// Each provider call's own wall time, which its deadline in the config has to cover.
const calls = vi.hoisted(() => [] as { model: string; ms: number }[]);
vi.mock("../src/providers/call", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/call")>();
  return {
    ...actual,
    callerFor: (model: Parameters<typeof actual.callerFor>[0]) => {
      const caller = actual.callerFor(model);
      return (async (call: Parameters<typeof caller>[0]) => {
        const startedAt = Date.now();
        try {
          return await caller(call);
        } finally {
          calls.push({ model: `${model.model} (${model.reasoning})`, ms: Date.now() - startedAt });
        }
      }) as typeof caller;
    },
  };
});

const DIR = new URL("fixtures/answers/languages/", import.meta.url);

/** What a reader checks by hand in each answer, names as written in it. */
interface Expected {
  language: MeasurementLanguage;
  /**
   * Offered as options, in the order the answer gives them: a platform the answer sends the reader
   * to book or buy through is one, unranked.
   */
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

// The production config, deadlines included: a call they cut counts as a failed extraction.
const config: ExtractorConfig = currentExtractorConfig;

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
  failed: number;
  slowestMs: number;
  /** The fewest characters per input token of an extraction without a judge. */
  charsPerToken: number;
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
  failed: 0,
  slowestMs: 0,
  charsPerToken: Number.POSITIVE_INFINITY,
});

/** What each call said about a name the score missed, to tell a skipped name from a dropped quote. */
function trace(outputs: StoredOutputs | undefined, misses: string[]): string[] {
  if (!outputs) return [];
  const lines = [`quote misses ${JSON.stringify(outputs.quoteMisses)}`];
  for (const call of ["primary", "secondary", "judge"] as const) {
    const said = outputs[call]?.output?.mentions;
    if (!said) continue;
    for (const m of said) {
      if (misses.some((miss) => miss.includes(m.name) || same(miss.split(": ")[1] ?? "", m.name))) {
        lines.push(`${call}: ${m.name} ${m.stance} ${m.entityKind} «${m.quote}»`);
      }
    }
  }
  return lines;
}

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
      if (m.ordinal !== null) ordinals.push(m.ordinal);
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

/** One extraction's wall time, for the deadline the free report can afford. */
interface Timing {
  language: MeasurementLanguage;
  chars: number;
  ms: number;
  outputTokens: number;
}

const LENGTHS = [
  { label: "< 3k chars", below: 3000 },
  { label: "3k–6k chars", below: 6000 },
  { label: "6k–10k chars", below: 10_000 },
  { label: "≥ 10k chars", below: Number.POSITIVE_INFINITY },
];

// Nearest rank, so a reported p95 is a latency that was actually observed.
function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number;
}

function latencyTable(timings: Timing[]): string {
  const row = (label: string, group: Timing[]) => {
    const ms = group.map((t) => t.ms).sort((a, b) => a - b);
    const out = group.reduce((n, t) => n + t.outputTokens, 0) / group.length;
    const s = (v: number) => `${(v / 1000).toFixed(1)} s`;
    return `| ${label} | ${group.length} | ${s(percentile(ms, 0.5))} | ${s(percentile(ms, 0.95))} | ${s(ms.at(-1) as number)} | ${Math.round(out)} |`;
  };
  const languages = [...new Set(timings.map((t) => t.language))].sort();
  const rows = [
    row("all", timings),
    ...languages.map((l) =>
      row(
        l,
        timings.filter((t) => t.language === l),
      ),
    ),
    ...LENGTHS.flatMap(({ label, below }, i) => {
      const from = i === 0 ? 0 : (LENGTHS[i - 1] as { below: number }).below;
      const group = timings.filter((t) => t.chars >= from && t.chars < below);
      return group.length > 0 ? [row(label, group)] : [];
    }),
  ];
  const models = [...new Set(calls.map((c) => c.model))].sort();
  const callRows = models.map((model) => {
    const ms = calls
      .filter((c) => c.model === model)
      .map((c) => c.ms)
      .sort((a, b) => a - b);
    const s = (v: number) => `${(v / 1000).toFixed(1)} s`;
    return `| ${model} | ${ms.length} | ${s(percentile(ms, 0.5))} | ${s(percentile(ms, 0.95))} | ${s(ms.at(-1) as number)} |`;
  });
  return [
    "| group | answers | p50 | p95 | max | output tokens |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "| call | calls | p50 | p95 | max |",
    "|---|---|---|---|---|",
    ...callRows,
  ].join("\n");
}

const rate = (n: number, d: number) => (d === 0 ? null : n / d);
const pct = (r: number | null) => (r === null ? "–" : `${(r * 100).toFixed(1)} %`);

// One extraction per recorded answer with the production pair and judge, a few US cents in all.
test("extraction finds, orders and judges entities in every measurement language", async () => {
  const tallies = new Map<MeasurementLanguage, Tally>();
  const timings: Timing[] = [];
  calls.length = 0;
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
    const t = tallies.get(e.language) ?? empty();
    tallies.set(e.language, t);
    // A failed extraction finds nothing: it counts against the language instead of hiding the rest.
    let result: Awaited<ReturnType<typeof extractResponse>> | null = null;
    let failure = "";
    try {
      result = await extractResponse(raw, { spend }, { config });
      t.slowestMs = Math.max(t.slowestMs, result.latencyMs);
      timings.push({
        language: e.language,
        chars: answer.markdown.length,
        ms: result.latencyMs,
        outputTokens: stored.outputTokens.get(raw.capture.id) ?? 0,
      });
      const outputs = stored.outputs.get(raw.capture.id);
      const tokens = stored.inputTokens.get(raw.capture.id);
      if (outputs && tokens && !outputs.judge) {
        const calls = outputs.secondary ? 2 : 1;
        const chars = (EXTRACT_PROMPT_V3.length + answer.markdown.length) * calls;
        t.charsPerToken = Math.min(t.charsPerToken, chars / tokens);
      }
    } catch (error) {
      t.failed++;
      failure = ` failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const misses = score(t, result?.mentions ?? [], e);
    if (misses.length > 0 || failure) {
      const lines = [...misses, ...trace(stored.outputs.get(raw.capture.id), misses)];
      console.log(`${id} (${result?.agreement ?? "none"})${failure}\n  ${lines.join("\n  ")}`);
    }
  });

  const rows = [...tallies.entries()].sort(([a], [b]) => a.localeCompare(b));
  const table = [
    "| language | answers | recommended recall | recommendation precision | order | negative recall | incidental recall | failed | slowest | chars/token |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      ([language, t]) =>
        `| ${language} | ${t.answers} | ${pct(rate(t.recommendedFound, t.recommended))} | ${pct(
          rate(t.recommendationsExpected, t.recommendations),
        )} | ${pct(rate(t.pairsInOrder, t.pairs))} | ${pct(rate(t.negativeFound, t.negative))} | ${pct(
          rate(t.incidentalFound, t.incidental),
        )} | ${t.failed} | ${(t.slowestMs / 1000).toFixed(1)} s | ${t.charsPerToken.toFixed(2)} |`,
    ),
  ].join("\n");
  const latency = latencyTable(timings);
  console.log(`${table}\n\n${latency}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n\n${latency}\n`);
  }

  for (const [language, t] of rows) {
    expect(t.failed, `${language} failed extractions`).toBe(0);
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
