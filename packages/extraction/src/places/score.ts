import type { ExtractorConfig } from "../config";
import { jaroWinkler, normalizeName, tokenContainment } from "../normalize";
import type { PlaceHit } from "./client";

type ResolutionConfig = ExtractorConfig["resolution"];

export interface ScoredCandidate {
  hit: PlaceHit;
  score: number;
  /** Weighted contribution of each signal, so a decision can be audited part by part. */
  parts: {
    name: number;
    tokens: number;
    type: number;
    location: number;
    operational: number;
    domain: number;
  };
  /** The mention cites URLs but the candidates' websites were not fetched yet. */
  awaitingWebsite: boolean;
}

export type Decision =
  | { outcome: "place"; placeId: string; method: "rules" | "judge"; score: number }
  | { outcome: "chain"; score: number }
  | { outcome: "unresolvable"; score: number | null; method: "rules" | "judge" };

// Scores are sums of weighted floats: 0.98 - 0.90 must still count as a 0.08 margin.
const EPSILON = 1e-9;

function hostOf(value: string): string | null {
  let host = value.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  return host || null;
}

function containsWords(haystack: string, needle: string): boolean {
  return needle !== "" && ` ${haystack} `.includes(` ${needle} `);
}

export function scoreCandidates(
  m: { nameNorm: string; locationHint: string | null; citedDomains: string[] },
  hits: PlaceHit[],
  ctx: { categoryTypes: string[]; websites?: Map<string, string> },
  cfg: ResolutionConfig,
): ScoredCandidate[] {
  const { weights } = cfg;
  const hintNorm = m.locationHint === null ? null : normalizeName(m.locationHint);
  const cited = new Set(m.citedDomains.map(hostOf).filter((host) => host !== null));
  const categoryTypes = new Set(ctx.categoryTypes);
  const awaitingWebsite = cited.size > 0 && ctx.websites === undefined;

  return hits
    .map((hit): ScoredCandidate => {
      const displayNorm = normalizeName(hit.displayName);
      const website = ctx.websites?.get(hit.id);
      const websiteHost = website === undefined ? null : hostOf(website);
      const parts = {
        name: weights.name * jaroWinkler(m.nameNorm, displayNorm),
        tokens: tokenContainment(m.nameNorm, displayNorm) ? weights.tokens : 0,
        type: hit.types.some((type) => categoryTypes.has(type)) ? weights.type : 0,
        location:
          hintNorm !== null &&
          hit.formattedAddress !== null &&
          containsWords(normalizeName(hit.formattedAddress), hintNorm)
            ? weights.location
            : 0,
        operational: hit.businessStatus === "OPERATIONAL" ? weights.operational : 0,
        domain: websiteHost !== null && cited.has(websiteHost) ? weights.domain : 0,
      };
      const sum =
        parts.name + parts.tokens + parts.type + parts.location + parts.operational + parts.domain;
      return { hit, score: Math.min(1, sum), parts, awaitingWebsite };
    })
    .sort((a, b) => b.score - a.score);
}

export function decide(
  scored: ScoredCandidate[],
  m: { locationHint: string | null },
  cfg: ResolutionConfig,
):
  | Decision
  | { outcome: "needs_judge"; top3: ScoredCandidate[] }
  | { outcome: "needs_website"; top2: ScoredCandidate[] } {
  const [top, second] = scored;
  if (top === undefined) return { outcome: "unresolvable", score: null, method: "rules" };

  // A permanently closed site with the same name is history, not another branch.
  const branches = scored.filter(
    (c) =>
      c.parts.name >= cfg.resolved * cfg.weights.name - EPSILON &&
      c.hit.businessStatus !== "CLOSED_PERMANENTLY",
  );
  if (m.locationHint === null && branches.length >= 2) {
    return { outcome: "chain", score: top.score };
  }

  const margin = top.score - (second?.score ?? 0);
  const close = margin < cfg.margin - EPSILON;
  if (!close && top.score >= cfg.resolved - EPSILON) {
    return { outcome: "place", placeId: top.hit.id, method: "rules", score: top.score };
  }
  // The domain bonus can reorder the top two, so it is worth fetching only while it can still
  // lift the best candidate over the floor.
  if (
    close &&
    second !== undefined &&
    top.awaitingWebsite &&
    top.score + cfg.weights.domain >= cfg.floor - EPSILON
  ) {
    return { outcome: "needs_website", top2: [top, second] };
  }
  if (top.score < cfg.floor - EPSILON) {
    return { outcome: "unresolvable", score: top.score, method: "rules" };
  }
  return { outcome: "needs_judge", top3: scored.slice(0, 3) };
}
