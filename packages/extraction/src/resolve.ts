import { createHash } from "node:crypto";
import { isEnabled } from "@reranker/flags";
import {
  QuotaExceededError,
  RateLimitedError,
  SpendCapExceededError,
  type SpendContext,
} from "@reranker/jobs";
import { AppError } from "@reranker/schema";
import type {
  BusinessCategory,
  EntityKey,
  EntityKind,
  ExtractedMention,
  GeoTarget,
  ResolutionMethod,
  ResolutionStatus,
  ResolvedMention,
  ResponseExtraction,
  TargetBusiness,
} from "@reranker/schema/measurement";
import { currentExtractorConfig } from "./config";
import { languageOfCountry } from "./language";
import { jaroWinkler, nameHmac, normalizeName, normalizeText } from "./normalize";
import {
  type CachedDecision,
  type DecisionKey,
  readDecisions,
  writeDecisions,
} from "./places/cache";
import {
  type LatLng,
  type PlaceHit,
  placeDetails,
  type SearchTextRequest,
  searchText,
} from "./places/client";
import { decide, type ScoredCandidate, scoreCandidates } from "./places/score";
import { platformFor } from "./platforms";
import { RESOLVE_JUDGE_PROMPT_V2 } from "./prompts/resolve-judge.v2";
import { callerFor, paidCall } from "./providers/call";
import { ResolveJudgeSchema } from "./schema";
import { extractionIdsOf, insertMentions, type MentionRow } from "./store";

type Scope = BusinessCategory["scope"];

const config = currentExtractorConfig;
// Only these can be a place in Places; platforms and media keep their own keys.
const RESOLVABLE = new Set<EntityKind>(["business", "professional", "chain"]);
const CITY_BIAS_RADIUS_M = 20_000;
// Places caps a bias circle at 50 km, so a region is biased with a box of this half side.
const REGION_BIAS_HALF_SIDE_M = 80_000;
const METERS_PER_DEGREE = 111_320;
// The mentions table holds at most 64 digests per mention.
const MAX_CITED_URLS = 64;
const RESOLVE_LANES = 4;
const JUDGE_MAX_OUTPUT_TOKENS = 1024;
const JUDGE_CHOICES = ["candidate_1", "candidate_2", "candidate_3"] as const;
// Places quota or our Places budget ran out: the rest of the report keeps name keys.
const EXHAUSTED = [RateLimitedError, QuotaExceededError, SpendCapExceededError];

const isPlatformKind = (kind: EntityKind) => kind === "platform" || kind === "directory_or_media";

function hostOf(url: string): string | null {
  try {
    const { hostname } = new URL(url.includes("://") ? url : `https://${url}`);
    return (
      hostname
        .toLowerCase()
        .replace(/\.$/, "")
        .replace(/^www\./, "") || null
    );
  } catch {
    return null;
  }
}

const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Where an entity is counted: its geo for a local business, its country for a national one. */
const scopeKeyOf = (geo: GeoTarget, scope: Scope) =>
  scope === "national" ? geo.country.toLowerCase() : geo.key;

// A professional's name never leaves this package in clear, not even inside a key.
const labelOf = (m: Pick<ExtractedMention, "nameNorm" | "entityKind">) =>
  m.entityKind === "professional" ? nameHmac(m.nameNorm) : m.nameNorm;

export function entityKeyOf(
  m: ExtractedMention,
  d: CachedDecision | null,
  geo: GeoTarget,
  scope: Scope,
): EntityKey {
  if (isPlatformKind(m.entityKind)) {
    const platform = platformFor(m, config.platforms);
    if (platform) return `platform:${platform.slug}`;
  }
  if (d?.outcome === "place") return `place:${d.placeId}`;
  const at = scopeKeyOf(geo, scope);
  return d?.outcome === "chain" ? `chain:${labelOf(m)}@${at}` : `name:${labelOf(m)}@${at}`;
}

// Folded with the mention's kind so a titled target ("Dra. Ana Gómez") matches its mentions.
const targetNamesOf = (target: TargetBusiness, kind: EntityKind) =>
  [target.inputName, ...target.aliases].map((name) => normalizeName(name, kind)).filter(Boolean);

function citesDomain(m: ExtractedMention, domain: string | null): boolean {
  if (domain === null) return false;
  const bare = domain.toLowerCase().replace(/^www\./, "");
  return m.citedUrls.some((url) => {
    const host = hostOf(url);
    return host !== null && onDomain(host, bare);
  });
}

/** The target by its name, an alias or a cited domain, before or without Places. */
export function matchesTarget(m: ExtractedMention, target: TargetBusiness): boolean {
  if (isPlatformKind(m.entityKind)) return false;
  if (citesDomain(m, target.domain)) return true;
  return targetNamesOf(target, m.entityKind).some(
    (name) => jaroWinkler(m.nameNorm, name) >= config.merge.nameJw,
  );
}

interface Cluster {
  nameNorm: string;
  kind: EntityKind;
  members: ExtractedMention[];
  recommendations: number;
  targetLike: boolean;
}

type Resolution = { decision: CachedDecision; cached: boolean };

/** Groups the report's resolvable mentions by name; professionals only among themselves. */
function clusterMentions(extractions: ResponseExtraction[], target: TargetBusiness) {
  const clusters: Cluster[] = [];
  const of = new Map<ExtractedMention, Cluster>();
  // Names already placed, so a repeated name skips the pairwise comparison.
  const seen = new Map<string, Cluster>();
  const targetNames = new Map<EntityKind, string[]>();
  const targetNamesFor = (kind: EntityKind) => {
    let names = targetNames.get(kind);
    if (!names) {
      names = targetNamesOf(target, kind);
      targetNames.set(kind, names);
    }
    return names;
  };
  for (const extraction of extractions) {
    for (const m of extraction.mentions) {
      if (!RESOLVABLE.has(m.entityKind)) continue;
      const professional = m.entityKind === "professional";
      const seenKey = `${professional}|${m.nameNorm}`;
      let cluster =
        seen.get(seenKey) ??
        clusters.find(
          (c) =>
            (c.kind === "professional") === professional &&
            jaroWinkler(c.nameNorm, m.nameNorm) >= config.merge.nameJw,
        );
      if (!cluster) {
        cluster = {
          nameNorm: m.nameNorm,
          kind: m.entityKind,
          members: [],
          recommendations: 0,
          targetLike: false,
        };
        clusters.push(cluster);
      }
      seen.set(seenKey, cluster);
      cluster.members.push(m);
      if (m.stance === "recommendation") cluster.recommendations++;
      cluster.targetLike ||=
        citesDomain(m, target.domain) ||
        targetNamesFor(m.entityKind).some(
          (name) => jaroWinkler(m.nameNorm, name) >= config.targetLikeJw,
        );
      of.set(m, cluster);
    }
  }
  return { clusters, of };
}

/** The target-like clusters and the most recommended ones; ties go to the first named. */
function selectClusters(clusters: Cluster[]): Set<Cluster> {
  const top = clusters
    .filter((c) => c.recommendations > 0)
    .sort((a, b) => b.recommendations - a.recommendations)
    .slice(0, config.liveResolutionTopN);
  return new Set([...clusters.filter((c) => c.targetLike), ...top]);
}

function boxAround(center: LatLng, halfSideM: number) {
  const dLat = halfSideM / METERS_PER_DEGREE;
  const dLng = halfSideM / (METERS_PER_DEGREE * Math.cos((center.latitude * Math.PI) / 180));
  const wrap = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180;
  return {
    low: {
      latitude: Math.max(-90, center.latitude - dLat),
      longitude: wrap(center.longitude - dLng),
    },
    high: {
      latitude: Math.min(90, center.latitude + dLat),
      longitude: wrap(center.longitude + dLng),
    },
  };
}

function locationBiasOf(geo: GeoTarget): SearchTextRequest["locationBias"] | undefined {
  if (geo.center === null) return undefined;
  const center = { latitude: geo.center.lat, longitude: geo.center.lng };
  // The area follows the place the point belongs to: a town located only by its region's
  // centroid is searched across the region.
  if (geo.center.level === "city") return { circle: { center, radius: CITY_BIAS_RADIUS_M } };
  return { rectangle: boxAround(center, REGION_BIAS_HALF_SIDE_M) };
}

function searchRequestOf(
  name: string,
  geo: GeoTarget,
  category: BusinessCategory,
): SearchTextRequest {
  const local = category.scope === "local";
  // `includedType` does not apply to hotel queries (Text Search docs).
  const includedType = category.archetype === "lodging" ? undefined : category.placesTypes[0];
  const locationBias = local ? locationBiasOf(geo) : undefined;
  return {
    textQuery: local ? `${name} ${geo.name}` : name,
    mask: "resolve",
    // Answers name businesses in their country's language; Places reads the name in it.
    languageCode: languageOfCountry(geo.country),
    regionCode: geo.country.toLowerCase(),
    ...(includedType !== undefined && { includedType }),
    ...(locationBias !== undefined && { locationBias }),
  };
}

/** The one location the cluster's mentions agree on; branches named apart cancel out. */
function locationHintOf(c: Cluster): string | null {
  const hints = new Map<string, string>();
  for (const m of c.members) {
    if (m.locationHint !== null) hints.set(normalizeText(m.locationHint), m.locationHint);
  }
  return hints.size === 1 ? ([...hints.values()][0] as string) : null;
}

// A platform listing is not the business's own site, so it can never match `websiteUri`.
function citedSitesOf(c: Cluster): string[] {
  const urls = new Set(c.members.flatMap((m) => m.citedUrls));
  return [...urls].filter(
    (url) => !platformFor({ nameNorm: "", citedUrls: [url] }, config.platforms),
  );
}

function judgeMessage(
  c: Cluster,
  m: { locationHint: string | null; citedDomains: string[] },
  top3: ScoredCandidate[],
  websites: Map<string, string>,
  geo: GeoTarget,
  category: BusinessCategory,
): string {
  const first = c.members[0] as ExtractedMention;
  return JSON.stringify({
    mention: {
      name: first.name,
      quote: first.quote,
      locationHint: m.locationHint,
      citedDomains: [...new Set(m.citedDomains.map(hostOf).filter((h) => h !== null))],
    },
    context: { category: category.label, place: geo.name },
    candidates: top3.map(({ hit }: { hit: PlaceHit }, i) => ({
      id: JUDGE_CHOICES[i],
      name: hit.displayName,
      address: hit.formattedAddress,
      types: hit.types,
      status: hit.businessStatus,
      website: websites.get(hit.id) ?? null,
    })),
  });
}

/** Only the Places side degrades the report; a failing judge fails it. */
class PlacesExhaustedError extends Error {
  override readonly name = "PlacesExhausted";
}

async function fromPlaces<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!EXHAUSTED.some((type) => error instanceof type)) throw error;
    throw new PlacesExhaustedError("Places quota or budget exhausted", { cause: error });
  }
}

/** Search, score and decide one cluster. */
async function resolveCluster(
  c: Cluster,
  input: { geo: GeoTarget; category: BusinessCategory; spend: SpendContext },
): Promise<CachedDecision> {
  const { geo, category, spend } = input;
  const first = c.members[0] as ExtractedMention;
  const m = {
    nameNorm: c.nameNorm,
    kind: c.kind,
    locationHint: locationHintOf(c),
    citedDomains: citedSitesOf(c),
  };
  const cfg = config.resolution;
  const ctx = { categoryTypes: category.placesTypes };

  const hits = await fromPlaces(() =>
    searchText(searchRequestOf(first.name, geo, category), spend),
  );
  let decision = decide(scoreCandidates(m, hits, ctx, cfg), m, cfg);
  const websites = new Map<string, string>();
  if (decision.outcome === "needs_website") {
    const { top2 } = decision;
    const found = await fromPlaces(() =>
      Promise.all(top2.map(({ hit }) => placeDetails(hit.id, "website", spend))),
    );
    for (const details of found) {
      if (details?.websiteUri) websites.set(details.id, details.websiteUri);
    }
    decision = decide(scoreCandidates(m, hits, { ...ctx, websites }, cfg), m, cfg);
  }
  if (decision.outcome === "needs_website") {
    throw new AppError("internal", { detail: "resolution asked for websites twice" });
  }
  if (decision.outcome === "chain")
    return { outcome: "chain", score: decision.score, method: "rules" };
  if (decision.outcome !== "needs_judge") return decision;

  const model = config.models.resolveJudge;
  const { output } = await paidCall(
    callerFor(model),
    {
      model,
      system: RESOLVE_JUDGE_PROMPT_V2,
      user: judgeMessage(c, m, decision.top3, websites, geo, category),
      schema: ResolveJudgeSchema,
      schemaName: "resolve_judge",
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    },
    { timeoutMs: config.timeoutsMs.judge, retries: 0, spend },
  );
  const chosen =
    decision.top3[JUDGE_CHOICES.indexOf(output.choice as (typeof JUDGE_CHOICES)[number])];
  if (chosen)
    return { outcome: "place", placeId: chosen.hit.id, score: chosen.score, method: "judge" };
  return { outcome: "unresolvable", score: decision.top3[0]?.score ?? null, method: "judge" };
}

/**
 * Runs the work a few at a time and stops taking more after the first failure; every started
 * item finishes before the failure is thrown, so nothing keeps running behind the caller.
 */
async function inLanes<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const lane = async () => {
    while (!failed && next < items.length) {
      try {
        await work(items[next++] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(RESOLVE_LANES, items.length) }, lane),
  );
  const rejected = settled.find((s) => s.status === "rejected");
  if (rejected) throw rejected.reason;
}

const STATUS: Record<CachedDecision["outcome"], ResolutionStatus> = {
  place: "resolved",
  chain: "chain",
  unresolvable: "unresolvable",
};

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Resolves the entities the report shows to Places: the target-like ones and the most
 * recommended, through the decision cache, Places and the resolution judge. Everything else keeps
 * a name key. Stores the mentions the report uses and returns every extraction resolved.
 */
export async function resolveReportMentions(input: {
  extractions: ResponseExtraction[];
  geo: GeoTarget;
  category: BusinessCategory;
  target: TargetBusiness;
  spend: SpendContext;
}): Promise<ResponseExtraction[]> {
  const { extractions, geo, category, target } = input;
  const scope = category.scope;
  const { clusters, of } = clusterMentions(extractions, target);
  const selected = selectClusters(clusters);

  const resolutions = new Map<Cluster, Resolution>();
  if (selected.size > 0 && (await isEnabled("places-resolution", { kind: "system" }))) {
    const keyOf = (c: Cluster): DecisionKey => ({
      nameHmac: nameHmac(c.nameNorm),
      geoKey: scopeKeyOf(geo, scope),
      categoryKey: category.key,
    });
    const flat = (k: DecisionKey) => `${k.nameHmac}|${k.geoKey}|${k.categoryKey}`;
    const wanted = [...selected];
    const cached = await readDecisions(wanted.map(keyOf), config.configHash);
    const misses: Cluster[] = [];
    for (const c of wanted) {
      const decision = cached.get(flat(keyOf(c)));
      if (decision) resolutions.set(c, { decision, cached: true });
      else misses.push(c);
    }

    let exhausted = false;
    const fresh: Array<DecisionKey & { decision: CachedDecision }> = [];
    try {
      await inLanes(misses, async (c) => {
        if (exhausted) return;
        let decision: CachedDecision;
        try {
          decision = await resolveCluster(c, input);
        } catch (error) {
          if (!(error instanceof PlacesExhaustedError)) throw error;
          exhausted = true;
          return;
        }
        resolutions.set(c, { decision, cached: false });
        fresh.push({ ...keyOf(c), decision });
      });
    } finally {
      // Decisions already paid for are kept even when another cluster failed the step.
      await writeDecisions(fresh, config.configHash);
    }
  }

  const resolve = (m: ExtractedMention): ResolvedMention => {
    const cluster = of.get(m);
    if (!cluster) {
      const entityKey = entityKeyOf(m, null, geo, scope);
      const platform = entityKey.startsWith("platform:");
      return {
        ...m,
        entityKey,
        placeId: null,
        resolution: {
          status: platform ? "platform" : "not_attempted",
          method: "none",
          score: null,
        },
        isTarget: !platform && matchesTarget(m, target),
      };
    }
    const r = resolutions.get(cluster) ?? null;
    const decision = r?.decision ?? null;
    const placeId = decision?.outcome === "place" ? decision.placeId : null;
    // Once Places decided, only the target's own listing is the target.
    const isTarget =
      target.placeId !== null && decision !== null
        ? placeId === target.placeId
        : matchesTarget(m, target);
    const web = isTarget && target.placeId === null && target.domain !== null;
    const method: ResolutionMethod = r === null ? "none" : r.cached ? "cache" : r.decision.method;
    return {
      ...m,
      entityKey: web
        ? `web:${target.domain}`
        : entityKeyOf({ ...m, nameNorm: cluster.nameNorm }, decision, geo, scope),
      // A target without a listing is its website, whatever Places matched by name.
      placeId: web ? null : placeId,
      resolution: {
        status: decision ? STATUS[decision.outcome] : "not_attempted",
        method,
        score: decision?.score ?? null,
      },
      isTarget,
    };
  };

  const resolved = extractions.map((e) => ({ ...e, mentions: e.mentions.map(resolve) }));
  await storeMentions(resolved, extractions, of, selected);
  return resolved;
}

/** Only what the report uses: recommendations of the selected entities and all of the target. */
async function storeMentions(
  resolved: ResponseExtraction[],
  extractions: ResponseExtraction[],
  of: Map<ExtractedMention, Cluster>,
  selected: Set<Cluster>,
): Promise<void> {
  const kept = resolved.map((e, i) =>
    e.mentions.filter((m, j) => {
      const cluster = of.get(extractions[i]?.mentions[j] as ExtractedMention);
      return (
        m.isTarget ||
        (m.stance === "recommendation" && cluster !== undefined && selected.has(cluster))
      );
    }),
  );
  const byConfig = new Map<string, string[]>();
  resolved.forEach((e, i) => {
    if (kept[i]?.length)
      byConfig.set(e.configHash, [...(byConfig.get(e.configHash) ?? []), e.captureId]);
  });
  const ids = new Map<string, string>();
  for (const [configHash, captureIds] of byConfig) {
    for (const [captureId, id] of await extractionIdsOf(captureIds, configHash)) {
      ids.set(`${configHash}|${captureId}`, id);
    }
  }

  const rows: MentionRow[] = [];
  resolved.forEach((e, i) => {
    for (const m of kept[i] ?? []) {
      const extractionId = ids.get(`${e.configHash}|${e.captureId}`);
      if (extractionId === undefined) {
        throw new AppError("internal", { detail: `extraction of ${e.captureId} is not stored` });
      }
      rows.push({
        extractionId,
        entityKey: m.entityKey,
        entityKind: m.entityKind,
        stance: m.stance,
        sentiment: m.sentiment,
        ordinal: m.ordinal,
        startOffset: m.startOffset,
        endOffset: m.endOffset,
        nameNorm: m.entityKind === "professional" ? null : m.nameNorm,
        nameHmac: nameHmac(m.nameNorm),
        placeId: m.placeId,
        resolutionStatus: m.resolution.status,
        resolutionMethod: m.resolution.method,
        resolutionScore: m.resolution.score,
        isTarget: m.isTarget,
        citedUrlHashes: [...new Set(m.citedUrls.map(sha256Hex))].slice(0, MAX_CITED_URLS),
      });
    }
  });
  await insertMentions(rows);
}
