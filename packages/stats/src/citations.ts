import type { EngineId } from "@reranker/schema";
import {
  type CitationStats,
  type CitedDomain,
  type EntityKey,
  isGoogleRedirect,
  platformOfUrl,
} from "@reranker/schema/measurement";
import { getDomain } from "tldts";
import { estimateRate, type StratumCounts } from "./rate";

/** A source as an engine returned it; `EngineAnswer.sources` entries fit as they are. */
export interface CitedSource {
  url: string;
  cited: boolean;
  /** Where a Google redirect in `url` leads, when it resolved. */
  resolvedUrl?: string;
}

/** One answer's citations: distinct cited URLs per key, and those no site can be read from. */
export interface AnswerCitations {
  byKey: Map<EntityKey, number>;
  unattributed: number;
}

// Private PSL rules on: a site on blogspot.com or github.io belongs to its owner, not the host.
const PSL = { allowPrivateDomains: true, extractHostname: false } as const;

/** The registrable domain (eTLD+1 under the Public Suffix List) of a host, or the host itself
 * when it has none, such as an IP address. */
export function registrableDomain(host: string): string {
  const bare = host.toLowerCase().replace(/\.$/, "");
  return getDomain(bare, PSL) ?? bare;
}

/** A cited URL's typed key: its platform when the registry knows it, else its registrable domain. */
export function citationKeyOf(raw: string): EntityKey | null {
  const url = URL.parse(raw);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const platform = platformOfUrl(url.href);
  return platform === null ? `web:${registrableDomain(url.hostname)}` : `platform:${platform.slug}`;
}

/**
 * The URLs an answer cites, read once each: its sources marked cited and the links the
 * extraction tied to a mention, through their resolved redirect when Google wrapped them.
 */
export function citationsOf(
  sources: readonly CitedSource[],
  mentionUrls: readonly string[] = [],
): AnswerCitations {
  const resolved = new Map<string, string | undefined>();
  for (const s of sources) {
    if (s.cited) resolved.set(s.url, s.resolvedUrl);
  }
  // A link the extraction copied may be a redirect the sources already resolved.
  const resolvedOf = new Map(sources.map((s) => [s.url, s.resolvedUrl]));
  for (const url of mentionUrls) {
    if (!resolved.has(url)) resolved.set(url, resolvedOf.get(url));
  }

  const seen = new Set<string>();
  const byKey = new Map<EntityKey, number>();
  let unattributed = 0;
  for (const [url, resolvedUrl] of resolved) {
    const target = resolvedUrl ?? url;
    if (isGoogleRedirect(target)) {
      unattributed++;
      continue;
    }
    const parsed = URL.parse(target);
    if (parsed === null) continue;
    // The same page with its fragment or campaign tags is one citation; OpenAI tags every link.
    parsed.hash = "";
    // Deleting reserializes the query, so an untagged one is left as written.
    const tags = [...parsed.searchParams.keys()].filter((name) => name.startsWith("utm_"));
    for (const name of tags) parsed.searchParams.delete(name);
    if (seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    const key = citationKeyOf(parsed.href);
    if (key !== null) byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  return { byKey, unattributed };
}

/**
 * The keys of the business's own sites. A host the registry knows as a platform is never its
 * own: a business whose site is an Instagram profile does not own every Instagram citation.
 */
export function targetKeysOf(domains: readonly string[]): Set<EntityKey> {
  const keys = new Set<EntityKey>();
  for (const domain of domains) {
    const key = citationKeyOf(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`);
    if (key?.startsWith("web:")) keys.add(key);
  }
  return keys;
}

export interface CitationCapture {
  engine: EngineId;
  stratum: string;
  weight: number;
  engineWeight: number;
}

type WeightOf = (i: number) => number;

/** Each answer's share of an index set's p̂: W_h / n_h, over the strata the set reaches. */
function unitWeights(
  captures: readonly CitationCapture[],
  indices: readonly number[],
  weightOf: WeightOf,
): Map<number, number> {
  const strata = new Map<string, { weight: number; n: number }>();
  for (const i of indices) {
    const stratum = (captures[i] as CitationCapture).stratum;
    const s = strata.get(stratum) ?? { weight: weightOf(i), n: 0 };
    s.n++;
    strata.set(stratum, s);
  }
  const total = [...strata.values()].reduce((sum, s) => sum + s.weight, 0);
  const units = new Map<number, number>();
  for (const i of indices) {
    const s = strata.get((captures[i] as CitationCapture).stratum) as { weight: number; n: number };
    units.set(i, total === 0 ? 0 : s.weight / s.n / total);
  }
  return units;
}

function rateOf(
  captures: readonly CitationCapture[],
  indices: readonly number[],
  hit: (i: number) => boolean,
  weightOf: WeightOf,
) {
  const strata = new Map<string, StratumCounts>();
  for (const i of indices) {
    const stratum = (captures[i] as CitationCapture).stratum;
    const s = strata.get(stratum) ?? { stratum, weight: weightOf(i), successes: 0, trials: 0 };
    s.successes += hit(i) ? 1 : 0;
    s.trials += 1;
    strata.set(stratum, s);
  }
  return estimateRate([...strata.values()]);
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The most cited keys of an index set, by weighted citation rate, each with its interval.
 * Ranking reads the point rate of every key; only the kept ones pay for an interval.
 */
function topCited(
  captures: readonly CitationCapture[],
  answers: readonly AnswerCitations[],
  indices: readonly number[],
  weightOf: WeightOf,
  topN: number,
  targetKeys: ReadonlySet<EntityKey>,
  keep: (key: EntityKey) => boolean = () => true,
): CitedDomain[] {
  const units = unitWeights(captures, indices, weightOf);
  const point = new Map<EntityKey, { rate: number; answers: number }>();
  for (const i of indices) {
    for (const key of (answers[i] as AnswerCitations).byKey.keys()) {
      if (!keep(key)) continue;
      const p = point.get(key) ?? { rate: 0, answers: 0 };
      p.rate += units.get(i) as number;
      p.answers++;
      point.set(key, p);
    }
  }
  return [...point.entries()]
    .sort(([ka, a], [kb, b]) => b.rate - a.rate || b.answers - a.answers || byKey(ka, kb))
    .slice(0, topN)
    .map(([key]) => ({
      key,
      isTarget: targetKeys.has(key),
      rate: rateOf(
        captures,
        indices,
        (i) => (answers[i] as AnswerCitations).byKey.has(key),
        weightOf,
      ),
    }));
}

export interface CitationInput {
  /** The report's valid answers, with their frame and per-engine stratum weights. */
  captures: readonly CitationCapture[];
  /** Aligned with `captures`. */
  answers: readonly AnswerCitations[];
  /** The business's own domains or site URLs. */
  targetDomains: readonly string[];
  /** Aligned with `captures`: whether the answer recommends the target, or any competitor. */
  recommendsTarget: ArrayLike<number>;
  recommendsCompetitor: ArrayLike<number>;
  topN: number;
}

export function citationStats(input: CitationInput): CitationStats {
  const { captures, answers, topN } = input;
  const all = captures.map((_, i) => i);
  const frameWeight: WeightOf = (i) => (captures[i] as CitationCapture).weight;
  const engineWeight: WeightOf = (i) => (captures[i] as CitationCapture).engineWeight;
  const byEngine = new Map<EngineId, number[]>();
  all.forEach((i) => {
    const engine = (captures[i] as CitationCapture).engine;
    const indices = byEngine.get(engine) ?? [];
    indices.push(i);
    byEngine.set(engine, indices);
  });

  const targetKeys = targetKeysOf(input.targetDomains);
  const targetUrls = (i: number) => {
    let n = 0;
    for (const key of targetKeys) n += (answers[i] as AnswerCitations).byKey.get(key) ?? 0;
    return n;
  };
  const urls = (i: number) => {
    let n = 0;
    for (const count of (answers[i] as AnswerCitations).byKey.values()) n += count;
    return n;
  };
  const citesTarget = (i: number) => targetUrls(i) > 0;

  // The share weighs each answer like the rates do, so an engine that cites ten links per
  // answer does not outweigh one that cites two.
  const units = unitWeights(captures, all, frameWeight);
  let ownMass = 0;
  let citedMass = 0;
  let own = 0;
  let total = 0;
  let unattributed = 0;
  for (const i of all) {
    const u = units.get(i) as number;
    ownMass += u * targetUrls(i);
    citedMass += u * urls(i);
    own += targetUrls(i);
    total += urls(i);
    unattributed += (answers[i] as AnswerCitations).unattributed;
  }

  const topByEngine: CitationStats["topByEngine"] = {};
  const targetByEngine: NonNullable<CitationStats["target"]>["byEngine"] = {};
  for (const [engine, indices] of byEngine) {
    topByEngine[engine] = topCited(captures, answers, indices, engineWeight, topN, targetKeys);
    if (targetKeys.size > 0) {
      targetByEngine[engine] = rateOf(captures, indices, citesTarget, engineWeight);
    }
  }

  // Sources that back a competitor and never the business: where it is missing.
  const forCompetitor = all.filter((i) => input.recommendsCompetitor[i] === 1);
  const forTarget = new Set<EntityKey>();
  for (const i of all) {
    if (input.recommendsTarget[i] === 1) {
      for (const key of (answers[i] as AnswerCitations).byKey.keys()) forTarget.add(key);
    }
  }
  const competitorOnly = forCompetitor.some((i) => frameWeight(i) > 0)
    ? topCited(
        captures,
        answers,
        forCompetitor,
        frameWeight,
        topN,
        targetKeys,
        (key) => !forTarget.has(key) && !targetKeys.has(key),
      )
    : [];

  return {
    answers: all.length,
    answersCiting: all.filter((i) => urls(i) > 0).length,
    citations: total,
    unattributed,
    target:
      targetKeys.size === 0
        ? null
        : {
            keys: [...targetKeys].sort(byKey),
            rate: rateOf(captures, all, citesTarget, frameWeight),
            byEngine: targetByEngine,
            share:
              citedMass === 0 ? null : { estimate: ownMass / citedMass, citations: own, total },
          },
    top: topCited(captures, answers, all, frameWeight, topN, targetKeys),
    topByEngine,
    competitorOnly,
  };
}
