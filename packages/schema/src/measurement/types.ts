import type { EngineId } from "../domain";
import type { EngineGeo, IntentId, IntentSetId } from "./catalog";
import type { EntityKey, EntityKind } from "./extraction";

export type LevelKey = "invisible" | "sometimes" | "on_the_list" | "regular"; // Invisible / A veces / En la lista / De los fijos
export type Sufficiency = "sufficient" | "orientative" | "insufficient";
export type LevelDisplay =
  | { kind: "single"; level: LevelKey }
  | { kind: "between"; from: LevelKey; to: LevelKey }
  | { kind: "insufficient" };

export interface RateEstimate {
  estimate: number; // 0..1
  lower: number;
  upper: number; // 95% Jeffreys on effective n
  successes: number;
  trials: number;
  effectiveTrials: number;
  designEffect: number;
  method: "jeffreys_eff";
}
export interface ScoreEstimate {
  value: number; // integer 0..100
  lower: number;
  upper: number; // integers, rounded outward
  atMost: number | null; // set when successes === 0 (copy: "a lo sumo {atMost}")
  level: LevelKey; // level of value
  levelDisplay: LevelDisplay;
  sufficiency: Sufficiency;
  preliminary: boolean;
  components: {
    recommendationRate: RateEstimate;
    prominence: { estimate: number; lower: number; upper: number; typicalPosition: number | null }; // G and its implied rank
  };
}

// Per-engine status shown by StatusBadge: the level of the engine score, or 'few_data'
// when the engine is not included (< 20 valid captures) or its levelDisplay is 'insufficient'
export type EngineStatus = LevelKey | "few_data";

export interface MentionCounts {
  recommended: number;
  incidental: number;
  negative: number;
  validCaptures: number;
}

export interface EntityStats {
  entityKey: EntityKey;
  displayName: string; // most frequent surface form in the responses (never from Places)
  isTarget: boolean;
  entityKind: EntityKind;
  overall: ScoreEstimate | null; // null when only point stats were computed
  pointValue: number; // always present
  byEngine: Partial<Record<EngineId, { score: ScoreEstimate; counts: MentionCounts }>>;
  counts: MentionCounts;
}

export interface Comparison {
  a: EntityKey;
  b: EntityKey;
  pAAhead: number;
  verdict: "ahead" | "behind" | "tied";
}

export interface EngineCoverage {
  engine: EngineId;
  planned: number;
  valid: number;
  failed: number;
  notPresent: number;
  namesEntitiesRate: RateEstimate | null; // null when the engine has no valid capture
  included: boolean;
  geo: EngineGeo; // copied from the frozen plan
}

export interface IntentCoverage {
  intentId: IntentId;
  namesEntitiesRate: RateEstimate;
  targetCounts: MentionCounts;
  targetScore: ScoreEstimate;
}

export interface FreeReportStats {
  methodologyVersion: string;
  methodologyHash: string;
  intentSetId: IntentSetId;
  intentSetHash: string;
  extractorConfigHash: string;
  seed: string;
  computedAt: string;
  target: EntityStats;
  competitors: EntityStats[]; // top 5 commercial entities by pointValue, excluding target
  rankingGroups: EntityKey[][]; // tie groups in order, target included
  comparisons: Comparison[]; // target vs each competitor
  platforms: { entityKey: EntityKey; displayName: string; recommendedShare: RateEstimate }[];
  engines: EngineCoverage[];
  intents: IntentCoverage[]; // intents with a valid capture in an included engine
  // Null when no included engine has a valid canonical capture.
  canonicalOnly: {
    target: ScoreEstimate;
    competitors: { entityKey: EntityKey; score: ScoreEstimate }[];
  } | null;
}

// Compact summary stored with the free report (≤ 1 KB) and sent with its result.
export interface FreeReportSummary {
  methodologyHash: string;
  target: {
    value: number;
    lower: number;
    upper: number;
    atMost: number | null;
    level: LevelKey;
    levelDisplay: LevelDisplay;
    sufficiency: Sufficiency;
  };
  preliminary: true; // always in the free report
  engines: Array<{
    engine: EngineId;
    status: EngineStatus;
    geo: EngineGeo;
    recommended: number;
    valid: number;
  }>;
  topCompetitors: Array<{
    entityKey: EntityKey;
    displayName: string;
    value: number;
    verdict: "ahead" | "behind" | "tied";
  }>; // ≤ 5
}
