import type { EngineAnswer } from "@reranker/capture";
import type { RawCapture } from "@reranker/extraction/extract";
import { DEFAULT_COUNTRY_CODE } from "@reranker/i18n/countries";
import { type CaptureChannel, cost, EngineId } from "@reranker/schema";
import type {
  EntityKey,
  IntentId,
  MeasurementPlan,
  PlannedObservation,
  ResolvedMention,
  ResponseExtraction,
} from "@reranker/schema/measurement";

// V0 design: 5 engines × 5 intents × 8 variants, engine-major, so slot = e·40 + i·8 + v.
export const ENGINES = EngineId.options;
export const INTENTS: IntentId[] = ["discovery", "price", "urgency", "trust", "zone"].map(
  (slug) => `dental_clinic.${slug}` as IntentId,
);
export const VARIANTS = 8;
export const PER_ENGINE = INTENTS.length * VARIANTS;
export const TARGET: EntityKey = "place:target";
export const RIVAL: EntityKey = "place:rival";
export const CONFIG = "f".repeat(64);

export const slotOf = (engine: EngineId, intent: number, variant: number) =>
  ENGINES.indexOf(engine) * PER_ENGINE + intent * VARIANTS + variant;

export const captureId = (slot: number) => `cap_${slot.toString().padStart(4, "0")}`;

export function mention(
  over: Partial<ResolvedMention> & { entityKey: EntityKey },
): ResolvedMention {
  const name = over.name ?? over.entityKey.slice(over.entityKey.indexOf(":") + 1);
  return {
    name,
    nameNorm: name.toLowerCase(),
    quote: name,
    startOffset: 0,
    endOffset: name.length,
    ordinal: 1,
    stance: "recommendation",
    entityKind: "business",
    sentiment: "positive",
    locationHint: null,
    citedUrls: [],
    placeId: null,
    resolution: { status: "resolved", method: "rules", score: 1 },
    isTarget: over.entityKey === TARGET,
    ...over,
  };
}

function observation(slot: number): PlannedObservation {
  const engine = ENGINES[Math.floor(slot / PER_ENGINE)] as EngineId;
  const intent = Math.floor((slot % PER_ENGINE) / VARIANTS);
  const variant = slot % VARIANTS;
  return {
    engine,
    provider: engine === "chatgpt" ? "brightdata" : "dataforseo",
    intentSetId: "is_0123456789abcdef",
    intentId: INTENTS[intent] as IntentId,
    paraphraseId: `p${intent}-${variant}`,
    geoKey: "co-c1003654",
    geoDeclared:
      engine === "perplexity"
        ? { level: "country", label: "Colombia" }
        : { level: "city", label: "Medellín" },
    runIndex: 0,
    promptText: `prompt ${slot}`,
    variantId: `pv_${slot.toString(16).padStart(16, "0")}`,
    promptSha256: "d".repeat(64),
    isCanonical: variant === 0,
  };
}

export const plan: MeasurementPlan = {
  intentSet: {
    id: "is_0123456789abcdef",
    kind: "seed",
    version: "2026.11.0",
    categoryKey: "dental_clinic",
    scope: "local",
    registerProfile: "co",
    contentHash: "b".repeat(64),
    merkleRoot: "c".repeat(64),
    variantCount: 210,
    generatorConfigHash: null,
    generators: 0,
  },
  geo: {
    key: "co-c1003654",
    level: "city",
    country: DEFAULT_COUNTRY_CODE,
    name: "Medellín",
    regionName: "Antioquia",
    center: { lat: 6.2442, lng: -75.5812 },
    dataforseo: { locationCode: 1003654, level: "city", label: "Medellin,Antioquia,Colombia" },
    enrichment: { divipola: { municipalityCode: "05001", departmentCode: "05" } },
    geoDataHash: "a".repeat(64),
  },
  scope: "local",
  seed: "e".repeat(64),
  design: { intents: INTENTS.length, variantsPerIntent: VARIANTS, runsPerVariant: 1 },
  observations: Array.from({ length: ENGINES.length * PER_ENGINE }, (_, slot) => observation(slot)),
};

export interface FixtureOptions {
  /** The first n slots of each engine fail; 'all' fails every slot. */
  failed?: Partial<Record<EngineId, number>> | "all";
  /** The n slots after the failed ones succeed without an AI answer. */
  notPresent?: Partial<Record<EngineId, number>>;
  mixedConfig?: boolean;
  channel?: Record<number, CaptureChannel>;
  /** Mentions of a slot's answer; by default the target is recommended first in even slots. */
  mentions?: (slot: number) => ResolvedMention[];
  intentWeights?: Partial<Record<IntentId, number>>;
}

const defaultMentions = (slot: number) =>
  slot % 2 === 0
    ? [mention({ entityKey: TARGET }), mention({ entityKey: RIVAL, ordinal: 2 })]
    : [mention({ entityKey: RIVAL })];

export function fixture(opts: FixtureOptions = {}) {
  const captures: RawCapture[] = [];
  const extractions: ResponseExtraction[] = [];
  plan.observations.forEach((o, slot) => {
    const nth = slot % PER_ENGINE;
    const failedCount = opts.failed === "all" ? PER_ENGINE : (opts.failed?.[o.engine] ?? 0);
    const failed = nth < failedCount;
    const present = !failed && nth >= failedCount + (opts.notPresent?.[o.engine] ?? 0);
    const channel = opts.channel?.[slot] ?? "ui-vendor";
    const mentions = present ? (opts.mentions ?? defaultMentions)(slot) : [];
    const answer: EngineAnswer | null = failed
      ? null
      : {
          parserVersion: "fixture@1",
          engine: o.engine,
          channel,
          provider: o.provider,
          modelReported: null,
          present,
          markdown: present ? "answer" : "",
          sources: [],
          searchQueries: "unavailable",
        };
    captures.push({
      capture: {
        id: captureId(slot),
        engine: o.engine,
        channel,
        status: failed ? "provider_error" : "succeeded",
        modelReported: null,
        slotId: `m1:${slot}`,
      },
      answer,
    });
    extractions.push({
      captureId: captureId(slot),
      configHash: opts.mixedConfig && slot === 7 ? "0".repeat(64) : CONFIG,
      answerKind: failed
        ? "capture_failed"
        : mentions.length > 0
          ? "names_entities"
          : "no_entities",
      agreement: "agreed",
      mentions,
      models: { primary: "m", secondary: null, judge: null },
      cost: cost(0, "USD"),
      latencyMs: 0,
    });
  });
  return {
    plan,
    captures,
    extractions,
    ...(opts.intentWeights === undefined ? {} : { intentWeights: opts.intentWeights }),
  };
}
