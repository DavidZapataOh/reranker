import type {
  EngineStatus,
  LevelDisplay,
  LevelKey,
  ScoreEstimate,
  Sufficiency,
} from "@reranker/schema/measurement";
import { methodology } from "./methodology";

const LEVELS: readonly LevelKey[] = ["invisible", "sometimes", "on_the_list", "regular"];

function assertOnScale(n: number): void {
  if (!(n >= 0 && n <= 100)) throw new RangeError(`Score off the 0–100 scale: ${n}`);
}

function assertRange(lower: number, upper: number): void {
  assertOnScale(lower);
  assertOnScale(upper);
  if (lower > upper) throw new RangeError(`Inverted range: ${lower} > ${upper}`);
}

function levelIndex(score: number): number {
  return methodology.levelCuts.filter((cut) => score >= cut).length;
}

export function levelOf(score: number): LevelKey {
  assertOnScale(score);
  return LEVELS[levelIndex(score)] as LevelKey;
}

export function levelDisplay(lower: number, upper: number): LevelDisplay {
  assertRange(lower, upper);
  const from = levelIndex(lower);
  const to = levelIndex(upper);
  if (from === to) return { kind: "single", level: LEVELS[from] as LevelKey };
  // Naming three or more levels would tell the reader nothing; the number alone is shown instead.
  if (to - from === 1)
    return { kind: "between", from: LEVELS[from] as LevelKey, to: LEVELS[to] as LevelKey };
  return { kind: "insufficient" };
}

export function sufficiency(lower: number, upper: number): Sufficiency {
  assertRange(lower, upper);
  const halfWidth = (upper - lower) / 2;
  if (halfWidth <= methodology.sufficiency.sufficient) return "sufficient";
  if (halfWidth <= methodology.sufficiency.orientative) return "orientative";
  return "insufficient";
}

export function engineStatus(
  coverage: { included: boolean },
  score: ScoreEstimate | null,
): EngineStatus {
  if (!coverage.included || score === null || score.levelDisplay.kind === "insufficient")
    return "few_data";
  return score.level;
}
