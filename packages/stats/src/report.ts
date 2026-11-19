import { AppError, type EngineId } from "@reranker/schema";
import type {
  Comparison,
  EntityKey,
  EntityKind,
  EntityStats,
  FreeReportStats,
  FreeReportSummary,
  IntentCoverage,
  IntentId,
  MeasurementPlan,
  MentionCounts,
  ResponseExtraction,
  ScoreEstimate,
} from "@reranker/schema/measurement";
import { type EntityColumn, pairedCompare, rankWithTies } from "./compare";
import { engineStatus } from "./levels";
import { methodology, seedFor } from "./methodology";
import {
  buildObservations,
  type ObservationFrame,
  type ObservedCapture,
  STANCE,
} from "./observations";
import { estimateRate, type StratumCounts } from "./rate";
import { type EntityObservation, estimateScore, pointScore } from "./score";

export interface FreeReportInput {
  reportId: string;
  plan: MeasurementPlan;
  captures: ObservedCapture[];
  extractions: ResponseExtraction[];
  /** The capture's closing time: read from the caller so the output stays reproducible. */
  asOf: Date;
  /** The business the report is about, also when no answer names it. */
  target: { entityKey: EntityKey; displayName: string; entityKind: EntityKind };
  intentWeights?: Partial<Record<IntentId, number>>;
}

type Capture = ObservationFrame["captures"][number];
type Entity = ObservationFrame["entities"] extends Map<EntityKey, infer E> ? E : never;

const COMMERCIAL = new Set<EntityKind>(["business", "professional", "chain"]);
const SUMMARY_NAME_MAX = 60;

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function displayNameOf(names: Map<string, number>, fallback: string): string {
  let best = fallback;
  let count = 0;
  // Map order is answer order, so a tie keeps the form seen first.
  for (const [name, n] of names) {
    if (n > count) {
      best = name;
      count = n;
    }
  }
  return best;
}

export function computeFreeReportStats(input: FreeReportInput): FreeReportStats {
  const frame = buildObservations(input);
  const { captures } = frame;
  const n = captures.length;
  const all = captures.map((_, i) => i);
  const seed = seedFor(input.reportId, methodology.hash);
  const seedOf = (key: string, ...scope: string[]) =>
    seedFor(input.reportId, methodology.hash, key, ...scope);
  const bootstrap = { frame, seed };
  const weighted = (indices: number[]) => indices.some((i) => captures[i]?.weight !== 0);

  // Within one engine only the intents' relative weights matter, so an excluded engine's own
  // rates use them directly.
  const intentWeight = (i: number) => input.intentWeights?.[(captures[i] as Capture).intentId] ?? 1;
  const frameWeight = (i: number) => (captures[i] as Capture).weight;

  const observationsOf = (
    column: EntityColumn,
    indices: number[],
    weightOf = frameWeight,
  ): EntityObservation[] =>
    indices.map((i) => {
      const c = captures[i] as Capture;
      const y = column.y[i] === 1 ? 1 : 0;
      const ordinal = column.ordinal[i] as number;
      return {
        captureIndex: i,
        stratum: c.stratum,
        weight: weightOf(i),
        y,
        ordinal: y === 1 && ordinal > 0 ? ordinal : null,
        isCanonical: c.isCanonical,
      };
    });

  const rateOf = (indices: number[], hit: (i: number) => boolean, weightOf = frameWeight) => {
    const strata = new Map<string, StratumCounts>();
    for (const i of indices) {
      const stratum = (captures[i] as Capture).stratum;
      const s = strata.get(stratum) ?? { stratum, weight: weightOf(i), successes: 0, trials: 0 };
      s.successes += hit(i) ? 1 : 0;
      s.trials += 1;
      strata.set(stratum, s);
    }
    return estimateRate([...strata.values()]);
  };

  // Counts describe every valid answer; rates and scores weigh only the included engines.
  const countsOf = (stance: Uint8Array, indices: number[]): MentionCounts => {
    const counts = { recommended: 0, incidental: 0, negative: 0, validCaptures: indices.length };
    for (const i of indices) {
      if (stance[i] === STANCE.recommendation) counts.recommended++;
      else if (stance[i] === STANCE.incidental) counts.incidental++;
      else if (stance[i] === STANCE.negative) counts.negative++;
    }
    return counts;
  };

  const byEngine = new Map<EngineId, number[]>();
  const byIntent = new Map<IntentId, number[]>();
  captures.forEach((c, i) => {
    const engine = byEngine.get(c.engine) ?? [];
    engine.push(i);
    byEngine.set(c.engine, engine);
    const intent = byIntent.get(c.intentId) ?? [];
    intent.push(i);
    byIntent.set(c.intentId, intent);
  });
  const canonical = all.filter((i) => captures[i]?.isCanonical);

  const targetKey = input.target.entityKey;
  const target: Entity = frame.entities.get(targetKey) ?? {
    column: { key: targetKey, y: new Uint8Array(n), ordinal: new Int16Array(n) },
    kind: input.target.entityKind,
    isTarget: true,
    names: new Map(),
    recommended: 0,
    incidental: 0,
    negative: 0,
    stance: new Uint8Array(n),
  };
  const targetObs = observationsOf(target.column, all);
  const targetOverall = estimateScore(targetObs, seedOf(targetKey), { bootstrap });

  const targetByEngine: EntityStats["byEngine"] = {};
  for (const [engine, indices] of byEngine) {
    const engineSeed = seedOf(targetKey, "engine", engine);
    // An included engine reads the report's shared draws; an excluded one weighs zero in the
    // frame, so it draws its own over its intents.
    targetByEngine[engine] = {
      score: weighted(indices)
        ? estimateScore(observationsOf(target.column, indices), engineSeed, { bootstrap })
        : estimateScore(observationsOf(target.column, indices, intentWeight), engineSeed),
      counts: countsOf(target.stance, indices),
    };
  }

  const targetStats: EntityStats = {
    entityKey: targetKey,
    displayName: displayNameOf(target.names, input.target.displayName),
    isTarget: true,
    entityKind: target.kind,
    overall: targetOverall,
    pointValue: targetOverall.value,
    byEngine: targetByEngine,
    counts: countsOf(target.stance, all),
  };

  // Mentions flagged as the target under another key are the business itself, never a rival.
  const rivals = [...frame.entities.entries()]
    .filter(([key, e]) => COMMERCIAL.has(e.kind) && key !== targetKey && !e.isTarget)
    .map(([key, e]) => ({
      key,
      entity: e,
      pointValue: e.recommended === 0 ? 0 : pointScore(observationsOf(e.column, all)),
    }));
  const fullInterval = new Set(
    [...rivals]
      .sort(
        (a, b) =>
          b.entity.recommended - a.entity.recommended ||
          b.pointValue - a.pointValue ||
          byKey(a.key, b.key),
      )
      .slice(0, methodology.fullIntervalTopN)
      .map((r) => r.key),
  );
  const shown = rivals
    .filter((r) => r.entity.recommended > 0)
    .sort(
      (a, b) =>
        b.pointValue - a.pointValue ||
        b.entity.recommended - a.entity.recommended ||
        byKey(a.key, b.key),
    )
    .slice(0, methodology.competitorsShown);

  const competitors: EntityStats[] = shown.map(({ key, entity, pointValue }) => ({
    entityKey: key,
    displayName: displayNameOf(entity.names, key),
    isTarget: false,
    entityKind: entity.kind,
    overall: fullInterval.has(key)
      ? estimateScore(observationsOf(entity.column, all), seedOf(key), { bootstrap })
      : null,
    pointValue,
    byEngine: {},
    counts: countsOf(entity.stance, all),
  }));

  const comparisons: Comparison[] = shown.map(({ key, entity }) => ({
    a: targetKey,
    b: key,
    ...pairedCompare(target.column, entity.column, frame, seed),
  }));

  const rankingGroups = rankWithTies(
    [
      { column: target.column, stats: targetStats },
      ...shown.map((r, i) => ({ column: r.entity.column, stats: competitors[i] as EntityStats })),
    ].map(({ column, stats }) => ({
      column,
      value: stats.overall?.value ?? stats.pointValue,
      pointValue: stats.pointValue,
    })),
    frame,
    seed,
  ) as EntityKey[][];

  const platforms = [...frame.entities.entries()]
    .filter(([, e]) => e.kind === "platform")
    .sort(([ka, a], [kb, b]) => b.recommended - a.recommended || byKey(ka, kb))
    .map(([key, e]) => ({
      entityKey: key,
      displayName: displayNameOf(e.names, key),
      recommendedShare: rateOf(all, (i) => e.column.y[i] === 1),
    }));

  const engines = frame.engines.map((e) => {
    const indices = byEngine.get(e.engine) ?? [];
    return {
      engine: e.engine,
      planned: e.planned,
      valid: e.valid,
      failed: e.failed,
      notPresent: e.notPresent,
      namesEntitiesRate:
        indices.length === 0
          ? null
          : rateOf(indices, (i) => captures[i]?.namesEntities === true, intentWeight),
      included: e.included,
      geo: e.geo,
    };
  });

  const intents: IntentCoverage[] = [];
  for (const [intentId, indices] of byIntent) {
    if (!weighted(indices)) continue;
    intents.push({
      intentId,
      namesEntitiesRate: rateOf(indices, (i) => captures[i]?.namesEntities === true),
      targetCounts: countsOf(target.stance, indices),
      targetScore: estimateScore(
        observationsOf(target.column, indices),
        seedOf(targetKey, "intent", intentId),
        { bootstrap },
      ),
    });
  }

  const canonicalScore = (key: string, column: EntityColumn): ScoreEstimate =>
    estimateScore(observationsOf(column, canonical), seedOf(key, "canonical"), { bootstrap });

  return {
    methodologyVersion: methodology.version,
    methodologyHash: methodology.hash,
    intentSetId: input.plan.intentSet.id,
    intentSetHash: input.plan.intentSet.contentHash,
    extractorConfigHash: frame.extractorConfigHash,
    seed,
    computedAt: input.asOf.toISOString(),
    target: targetStats,
    competitors,
    rankingGroups,
    comparisons,
    platforms,
    engines,
    intents,
    canonicalOnly: weighted(canonical)
      ? {
          target: canonicalScore(targetKey, target.column),
          competitors: shown.map(({ key, entity }) => ({
            entityKey: key,
            score: canonicalScore(key, entity.column),
          })),
        }
      : null,
  };
}

const truncate = (s: string, max: number) => {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max).join("");
};

export function toFreeReportSummary(stats: FreeReportStats): FreeReportSummary {
  const target = stats.target.overall;
  if (target === null) {
    throw new AppError("internal", { detail: "the target has no score range" });
  }
  const verdicts = new Map(stats.comparisons.map((c) => [c.b, c.verdict]));
  return {
    methodologyHash: stats.methodologyHash,
    target: {
      value: target.value,
      lower: target.lower,
      upper: target.upper,
      atMost: target.atMost,
      level: target.level,
      levelDisplay: target.levelDisplay,
      sufficiency: target.sufficiency,
    },
    preliminary: true,
    engines: stats.engines.map((e) => {
      const own = stats.target.byEngine[e.engine];
      return {
        engine: e.engine,
        status: engineStatus(e, own?.score ?? null),
        geo: e.geo,
        recommended: own?.counts.recommended ?? 0,
        valid: e.valid,
      };
    }),
    topCompetitors: stats.competitors.map((c) => {
      const verdict = verdicts.get(c.entityKey);
      if (verdict === undefined) {
        throw new AppError("internal", { detail: `competitor ${c.entityKey} was not compared` });
      }
      return {
        entityKey: c.entityKey,
        displayName: truncate(c.displayName, SUMMARY_NAME_MAX),
        value: c.overall?.value ?? c.pointValue,
        verdict,
      };
    }),
  };
}
