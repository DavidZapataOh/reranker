import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { estimateRows } from "../src/persist";
import { computeFreeReportStats } from "../src/report";
import { ENGINES, INTENTS, ladder, reportInput, TARGET } from "./fixtures/report-200";

const measurementId = randomUUID();
const stats = computeFreeReportStats(reportInput({ mentions: ladder }));
const rows = estimateRows(measurementId, stats);
const top5 = stats.competitors.map((c) => c.entityKey);

const keyOf = (r: (typeof rows)[number]) => `${r.entityKey}|${r.scope}|${r.scopeKey}|${r.metric}`;

test("the 22 rows the report shows: target score by scope, top 5 overall, names per engine", () => {
  expect(top5).toHaveLength(5);
  expect(rows.map(keyOf).sort()).toEqual(
    [
      `${TARGET}|overall|null|score`,
      ...ENGINES.map((e) => `${TARGET}|engine|${e}|score`),
      ...INTENTS.map((i) => `${TARGET}|intent|${i}|score`),
      `${TARGET}|canonical|null|score`,
      ...top5.map((c) => `${c}|overall|null|score`),
      ...ENGINES.map((e) => `*|engine|${e}|names_entities_rate`),
    ].sort(),
  );
});

test("score rows carry the score bounds, the rate counts, level and sufficiency", () => {
  const overall = stats.target.overall;
  const rate = overall?.components.recommendationRate;
  expect(rows.find((r) => keyOf(r) === `${TARGET}|overall|null|score`)).toEqual({
    measurementId,
    entityKey: TARGET,
    scope: "overall",
    scopeKey: null,
    metric: "score",
    estimate: overall?.value,
    lower: overall?.lower,
    upper: overall?.upper,
    successes: rate?.successes,
    trials: rate?.trials,
    effectiveTrials: rate?.effectiveTrials,
    designEffect: rate?.designEffect,
    level: overall?.level,
    sufficiency: overall?.sufficiency,
    methodologyHash: Buffer.from(stats.methodologyHash, "hex"),
    intentSetHash: Buffer.from(stats.intentSetHash, "hex"),
    extractorConfigHash: Buffer.from(stats.extractorConfigHash, "hex"),
    seed: Buffer.from(stats.seed, "hex"),
    computedAt: new Date(stats.computedAt),
  });
});

test("rate rows carry the rate itself and no level", () => {
  const engine = stats.engines[0];
  const row = rows.find((r) => keyOf(r) === `*|engine|${engine?.engine}|names_entities_rate`);
  expect(row).toMatchObject({
    estimate: engine?.namesEntitiesRate?.estimate,
    lower: engine?.namesEntitiesRate?.lower,
    upper: engine?.namesEntitiesRate?.upper,
    successes: engine?.namesEntitiesRate?.successes,
    level: null,
    sufficiency: null,
  });
});

test("absent estimates add no rows: no canonical data, an engine with no valid capture", () => {
  const partial = computeFreeReportStats(
    reportInput({ mentions: ladder, failed: { perplexity: 40 } }),
  );
  const keys = estimateRows(measurementId, { ...partial, canonicalOnly: null }).map(keyOf);
  expect(keys).not.toContain(`${TARGET}|canonical|null|score`);
  expect(keys).not.toContain(`${TARGET}|engine|perplexity|score`);
  expect(keys).not.toContain("*|engine|perplexity|names_entities_rate");
  expect(keys).toHaveLength(19);
});

test("citation rows: the business's sites by scope, top sites overall and per engine, competitor-only", () => {
  const cited = computeFreeReportStats(
    reportInput(
      {
        mentions: ladder,
        sources: (slot) => [
          ...(slot % 2 === 0 ? [{ url: "https://www.clinicasonrisas.com.co/", cited: true }] : []),
          ...(slot % 2 === 1 ? [{ url: "https://www.topdoctors.com.co/x", cited: true }] : []),
          { url: `https://site${slot % 12}.com.co/`, cited: true },
        ],
      },
      {
        target: { ...reportInput().target, domains: ["clinicasonrisas.com.co"] },
      },
    ),
  );
  const { citations } = cited;
  const keys = estimateRows(measurementId, cited)
    .filter((r) => r.metric.endsWith("citation_rate"))
    .map(keyOf);
  expect(keys.sort()).toEqual(
    [
      `${TARGET}|overall|null|site_citation_rate`,
      ...ENGINES.map((e) => `${TARGET}|engine|${e}|site_citation_rate`),
      ...citations.top.map((d) => `${d.key}|overall|null|citation_rate`),
      ...ENGINES.flatMap((e) =>
        (citations.topByEngine[e] ?? []).map((d) => `${d.key}|engine|${e}|citation_rate`),
      ),
      ...citations.competitorOnly.map((d) => `${d.key}|overall|null|competitor_citation_rate`),
    ].sort(),
  );
  expect(citations.top).toHaveLength(10);
  expect(citations.competitorOnly.map((d) => d.key)).toContain("platform:top-doctors");
  const site = estimateRows(measurementId, cited).find(
    (r) => keyOf(r) === `${TARGET}|overall|null|site_citation_rate`,
  );
  expect(site).toMatchObject({
    estimate: citations.target?.rate.estimate,
    lower: citations.target?.rate.lower,
    upper: citations.target?.rate.upper,
    successes: 100,
    trials: 200,
    level: null,
    sufficiency: null,
  });
});
