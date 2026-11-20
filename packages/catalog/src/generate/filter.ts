import { AppError } from "@reranker/schema";
import { ParaphraseFormat } from "@reranker/schema/measurement";
import type { Candidate } from "./guards";

const DUPLICATE_AT = 0.9;
const ON_TOPIC_FROM = 0.6;

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new AppError("internal", {
      detail: `cosine of ${a.length}- and ${b.length}-dim vectors`,
    });
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

// Mean of the unit vectors, so a long embedding cannot pull the centroid its way.
function centroid(embeddings: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(embeddings[0]?.length ?? 0);
  for (const e of embeddings) {
    const norm = Math.hypot(...e);
    if (norm === 0) continue;
    for (let i = 0; i < e.length; i++) out[i] = (out[i] as number) + (e[i] as number) / norm;
  }
  return out;
}

export type PoolReport = { dedupe: number; offCentroid: number; judge: number; quota: number };

/**
 * Picks the paraphrases an intent is measured with: paraphrases that drift from the centroid
 * (cosine < 0.60) or that the judge rejected go, near duplicates (≥ 0.90) keep only the one closest
 * to the centroid, and the top `keep` by closeness stay with at least `minPerFormat` of each format
 * that has them. Kept candidates come back closest first; nothing throws on an empty or rejected pool.
 */
export function selectPool(input: {
  candidates: Candidate[];
  embeddings: Float32Array[];
  judged: boolean[];
  keep: number;
  minPerFormat: number;
}): { kept: Candidate[]; report: PoolReport } {
  const { candidates, embeddings, judged } = input;
  if (embeddings.length !== candidates.length || judged.length !== candidates.length) {
    throw new AppError("internal", {
      detail: `${candidates.length} candidates, ${embeddings.length} embeddings, ${judged.length} verdicts`,
    });
  }
  const center = centroid(embeddings);
  const order = candidates
    .map((_, i) => ({ i, closeness: cosine(embeddings[i] as Float32Array, center) }))
    .sort((a, b) => b.closeness - a.closeness);

  // Rejected paraphrases leave before dedupe, so none of them can knock out an accepted twin.
  const onTopic = order.filter((row) => row.closeness >= ON_TOPIC_FROM);
  const judgedOk = onTopic.filter((row) => judged[row.i]);
  const approved: typeof order = [];
  for (const row of judgedOk) {
    const e = embeddings[row.i] as Float32Array;
    if (!approved.some((d) => cosine(embeddings[d.i] as Float32Array, e) >= DUPLICATE_AT)) {
      approved.push(row);
    }
  }
  const report: PoolReport = {
    dedupe: judgedOk.length - approved.length,
    offCentroid: order.length - onTopic.length,
    judge: onTopic.length - judgedOk.length,
    quota: 0,
  };

  const chosen = new Set<number>();
  for (const format of ParaphraseFormat.options) {
    const ofFormat = approved.filter((row) => candidates[row.i]?.format === format);
    for (const row of ofFormat.slice(0, input.minPerFormat)) chosen.add(row.i);
  }
  // Quotas are reserved first; if they alone exceed `keep`, the closest of them win.
  const reserved = approved.filter((row) => chosen.has(row.i)).slice(0, input.keep);
  const rest = approved.filter((row) => !chosen.has(row.i));
  const keptRows = new Set([...reserved, ...rest.slice(0, input.keep - reserved.length)]);
  const kept = approved
    .filter((row) => keptRows.has(row))
    .map((row) => candidates[row.i] as Candidate);
  report.quota = approved.length - kept.length;
  return { kept, report };
}
