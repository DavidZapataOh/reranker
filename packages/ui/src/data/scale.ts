import type { LevelDisplay, LevelKey, ScoreEstimate } from "@reranker/schema/measurement";
import { copy } from "../copy.ts";

// Drawing only: the statistics decide the level, so nothing here recomputes it from the value.
export const LEVEL_CUTS = [10, 40, 70] as const;
export const LEVEL_ORDER: readonly LevelKey[] = [
  "invisible",
  "sometimes",
  "on_the_list",
  "regular",
];

const SCALE_MAX = 100;
// A single-point range still needs a visible bracket.
const MIN_RANGE_WIDTH = 1;

const EDGES: readonly number[] = [0, ...LEVEL_CUTS, SCALE_MAX];
export const LEVEL_BANDS = LEVEL_ORDER.map((level, i) => {
  const x = EDGES[i] ?? 0;
  return { level, x, width: (EDGES[i + 1] ?? SCALE_MAX) - x };
});

const onScale = (n: number) => Number.isFinite(n) && n >= 0 && n <= SCALE_MAX;

export function assertScore(score: ScoreEstimate): void {
  const { value, lower, upper, atMost } = score;
  if (
    !onScale(value) ||
    !onScale(lower) ||
    !onScale(upper) ||
    lower > upper ||
    (atMost !== null && !onScale(atMost))
  ) {
    throw new RangeError(
      `Score out of the 0–100 scale: value ${value}, lower ${lower}, upper ${upper}, atMost ${atMost}`,
    );
  }
}

export function rangeGeometry(lower: number, upper: number): { x: number; width: number } {
  const x = Math.min(lower, SCALE_MAX - MIN_RANGE_WIDTH);
  return { x, width: Math.max(upper - x, MIN_RANGE_WIDTH) };
}

export function activeLevels(display: LevelDisplay): readonly LevelKey[] {
  if (display.kind === "single") return [display.level];
  if (display.kind === "insufficient") return [];
  const from = LEVEL_ORDER.indexOf(display.from);
  const to = LEVEL_ORDER.indexOf(display.to);
  return LEVEL_ORDER.slice(Math.min(from, to), Math.max(from, to) + 1);
}

// Spanish has no locale-specific case mappings, so the default ones are exact.
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function levelPhrase(display: LevelDisplay, labels: Record<LevelKey, string>): string {
  if (display.kind === "single") return labels[display.level];
  if (display.kind === "insufficient") return lowerFirst(copy.score.insufficient);
  const { between, and } = copy.score;
  return `${between} ${labels[display.from]} ${and} ${labels[display.to]}`;
}

export function levelCaption(display: LevelDisplay, labels: Record<LevelKey, string>): string {
  return upperFirst(levelPhrase(display, labels));
}

export function rangePhrase(score: ScoreEstimate): string {
  const { between, and, atMost } = copy.score;
  return score.atMost === null
    ? `${between} ${score.lower} ${and} ${score.upper}`
    : `${atMost} ${score.atMost}`;
}

export function scoreSentence(score: ScoreEstimate, labels: Record<LevelKey, string>): string {
  assertScore(score);
  return `${copy.score.score} ${score.value}, ${rangePhrase(score)}: ${levelPhrase(score.levelDisplay, labels)}`;
}
