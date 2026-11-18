import { methodology, seedFor } from "./methodology";
import { rngFromSeed } from "./rng";

/**
 * One entry per valid capture; strata weights already normalized. Treated as immutable: its
 * bootstrap draws are memoized per frame object and seed.
 */
export interface CaptureFrame {
  captures: Array<{ stratum: string; weight: number }>;
}

/** `key` holds an EntityKey; `y` and `ordinal` are aligned with `frame.captures`; ordinal 0 = none. */
export interface EntityColumn {
  key: string;
  y: Uint8Array;
  ordinal: Int16Array;
}

export type Verdict = "ahead" | "behind" | "tied";

/** Bootstrap weights of every capture in every draw: `weights[draw · n + capture]`. */
interface Replicates {
  n: number;
  weights: Float64Array;
}

function strataOf(frame: CaptureFrame): Array<{ weight: number; members: number[] }> {
  const index = new Map<string, { weight: number; members: number[] }>();
  frame.captures.forEach(({ stratum, weight }, i) => {
    if (!(weight >= 0 && Number.isFinite(weight))) {
      throw new RangeError(`stratum ${stratum} has an invalid weight ${weight}`);
    }
    const s = index.get(stratum);
    if (s === undefined) index.set(stratum, { weight, members: [i] });
    else if (s.weight !== weight) {
      throw new RangeError(`stratum ${stratum} has captures with different weights`);
    } else s.members.push(i);
  });
  return [...index.values()];
}

function draw(frame: CaptureFrame, seed: string): Replicates {
  const n = frame.captures.length;
  const draws = methodology.mcDraws;
  const strata = strataOf(frame)
    .filter((s) => s.weight > 0)
    .map((s) => ({ ...s, cuts: new Float64Array(s.members.length - 1) }));
  const weights = new Float64Array(draws * n);
  const rng = rngFromSeed(seed);

  for (let s = 0; s < draws; s++) {
    const row = s * n;
    for (const { weight, members, cuts } of strata) {
      // Dirichlet(1,…,1) inside the stratum as the spacings of m − 1 sorted uniforms: exact,
      // and cheaper than normalizing m Exp(1) draws because it needs no logarithms.
      for (let j = 0; j < cuts.length; j++) cuts[j] = rng.next();
      cuts.sort();
      let previous = 0;
      for (let j = 0; j < members.length; j++) {
        const cut = j < cuts.length ? (cuts[j] as number) : 1;
        weights[row + (members[j] as number)] = weight * (cut - previous);
        previous = cut;
      }
    }
  }
  return { n, weights };
}

// The frame and seed fix the draws, so every comparison against the same frame reuses them:
// the free report compares the target with each competitor and ranks them on one bootstrap.
const memo = new WeakMap<CaptureFrame, Map<string, Replicates>>();

function replicates(frame: CaptureFrame, seed: string): Replicates {
  const pairSeed = seedFor(seed, "pair");
  let bySeed = memo.get(frame);
  if (bySeed === undefined) {
    bySeed = new Map();
    memo.set(frame, bySeed);
  }
  let r = bySeed.get(pairSeed);
  if (r === undefined) {
    r = draw(frame, pairSeed);
    bySeed.set(pairSeed, r);
  }
  return r;
}

/** S in each draw, up to the factor 100 that no comparison needs. */
function scoresOf(column: EntityColumn, { n, weights }: Replicates): Float64Array {
  if (column.y.length !== n || column.ordinal.length !== n) {
    throw new RangeError(`column ${column.key} is not aligned with the ${n} captures of the frame`);
  }
  const recommended: number[] = [];
  const discounts: number[] = [];
  for (let i = 0; i < n; i++) {
    if (column.y[i] !== 1) continue;
    recommended.push(i);
    const ordinal = column.ordinal[i] as number;
    // -1 marks an unranked recommendation: it counts for the rate and says nothing about G.
    discounts.push(ordinal > 0 ? methodology.positionDiscount ** (ordinal - 1) : -1);
  }

  const scores = new Float64Array(methodology.mcDraws);
  if (recommended.length === 0) return scores;
  for (let s = 0; s < scores.length; s++) {
    const row = s * n;
    let rate = 0;
    let gNum = 0;
    let gDen = 0;
    for (let r = 0; r < recommended.length; r++) {
      const w = weights[row + (recommended[r] as number)] as number;
      rate += w;
      const d = discounts[r] as number;
      if (d >= 0) {
        gNum += w * d;
        gDen += w;
      }
    }
    // G = 1 without ranked recommendations, the same conservative bound as estimateScore.
    scores[s] = rate * (gDen > 0 ? gNum / gDen : 1);
  }
  return scores;
}

function probabilityAhead(a: Float64Array, b: Float64Array): number {
  let ahead = 0;
  let even = 0;
  for (let s = 0; s < a.length; s++) {
    const x = a[s] as number;
    const y = b[s] as number;
    if (x > y) ahead++;
    else if (x === y) even++;
  }
  return (ahead + even / 2) / a.length;
}

function verdictOf(pAAhead: number): Verdict {
  if (pAAhead >= methodology.tie.ahead) return "ahead";
  if (pAAhead <= methodology.tie.behind) return "behind";
  return "tied";
}

export function pairedCompare(
  a: EntityColumn,
  b: EntityColumn,
  frame: CaptureFrame,
  seed: string,
): { pAAhead: number; verdict: Verdict } {
  const reps = replicates(frame, seed);
  const pAAhead = probabilityAhead(scoresOf(a, reps), scoresOf(b, reps));
  return { pAAhead, verdict: verdictOf(pAAhead) };
}

export function rankWithTies(
  entities: Array<{ column: EntityColumn; value: number; pointValue: number }>,
  frame: CaptureFrame,
  seed: string,
): string[][] {
  if (entities.length === 0) return [];
  const reps = replicates(frame, seed);
  const ordered = entities
    .map((e) => ({ ...e, scores: scoresOf(e.column, reps) }))
    .sort(
      (x, y) =>
        y.value - x.value ||
        y.pointValue - x.pointValue ||
        (x.column.key < y.column.key ? -1 : x.column.key > y.column.key ? 1 : 0),
    );

  const groups: string[][] = [];
  ordered.forEach((entity, i) => {
    const previous = ordered[i - 1];
    if (previous !== undefined) {
      if (verdictOf(probabilityAhead(previous.scores, entity.scores)) === "tied") {
        (groups.at(-1) as string[]).push(entity.column.key);
        return;
      }
    }
    groups.push([entity.column.key]);
  });
  return groups;
}
