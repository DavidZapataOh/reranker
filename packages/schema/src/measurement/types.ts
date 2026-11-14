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
