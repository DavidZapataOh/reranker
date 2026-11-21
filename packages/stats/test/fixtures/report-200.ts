import { DEFAULT_COUNTRY_CODE } from "@reranker/i18n/countries";
import { type CaptureChannel, cost, EngineId } from "@reranker/schema";
import type {
  EntityKey,
  IntentId,
  MeasurementLanguage,
  MeasurementPlan,
  PlannedObservation,
  ResolvedMention,
  ResponseExtraction,
} from "@reranker/schema/measurement";
import type { ObservedCapture } from "../../src/observations";
import type { FreeReportInput } from "../../src/report";

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
    center: { lat: 6.2442, lng: -75.5812, level: "city", label: "Medellín" },
    dataforseo: { locationCode: 1003654, level: "city", label: "Medellin,Antioquia,Colombia" },
    enrichment: { divipola: { municipalityCode: "05001", departmentCode: "05" } },
    geoDataHash: "a".repeat(64),
  },
  scope: "local",
  seed: "e".repeat(64),
  design: { intents: INTENTS.length, variantsPerIntent: VARIANTS, runsPerVariant: 1 },
  observations: Array.from({ length: ENGINES.length * PER_ENGINE }, (_, slot) => observation(slot)),
};

// A second language on the half-sample floor: 4 variants per intent, appended after the main 200.
export const SECONDARY_INTENTS: IntentId[] = ["discovery", "price", "urgency", "trust", "zone"].map(
  (slug) => `dental_clinic.en-neutral-${slug}` as IntentId,
);
export const SECONDARY_VARIANTS = 4;
export const SECONDARY_PER_ENGINE = SECONDARY_INTENTS.length * SECONDARY_VARIANTS;
const SECONDARY_SET = "is_1111111111111111";

export function bilingualPlan(variants = SECONDARY_VARIANTS): MeasurementPlan {
  const perEngine = SECONDARY_INTENTS.length * variants;
  const secondary = Array.from({ length: ENGINES.length * perEngine }, (_, k) => {
    const engine = ENGINES[Math.floor(k / perEngine)] as EngineId;
    const intent = Math.floor((k % perEngine) / variants);
    const variant = k % variants;
    const slot = plan.observations.length + k;
    return {
      ...observation(ENGINES.indexOf(engine) * PER_ENGINE),
      intentSetId: SECONDARY_SET,
      intentId: SECONDARY_INTENTS[intent] as IntentId,
      paraphraseId: `en${intent}-${variant}`,
      language: "en" as const,
      promptText: `prompt ${slot}`,
      variantId: `pv_${slot.toString(16).padStart(16, "0")}`,
      isCanonical: variant === 0,
    } satisfies PlannedObservation;
  });
  return {
    ...plan,
    language: "es",
    secondary: {
      language: "en",
      intentSet: { ...plan.intentSet, id: SECONDARY_SET, registerProfile: "neutral" },
      design: { intents: SECONDARY_INTENTS.length, variantsPerIntent: variants, runsPerVariant: 1 },
    },
    observations: [
      ...plan.observations.map((o) => ({ ...o, language: "es" as const })),
      ...secondary,
    ],
  };
}

export interface FixtureOptions {
  /** The plan to answer; the V0 one-language plan by default. */
  plan?: MeasurementPlan;
  /** The first n slots of each engine fail; 'all' fails every slot. */
  failed?: Partial<Record<EngineId, number>> | "all";
  /** The first n slots of each engine in the second language fail. */
  secondaryFailed?: Partial<Record<EngineId, number>>;
  languageShares?: Partial<Record<MeasurementLanguage, number>>;
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
  const captures: ObservedCapture[] = [];
  const extractions: ResponseExtraction[] = [];
  const answered = opts.plan ?? plan;
  const seen = new Map<string, number>();
  answered.observations.forEach((o, slot) => {
    // Position within the engine's slots of the same language.
    const cell = `${o.engine}|${o.language === "en" ? "en" : ""}`;
    const nth = seen.get(cell) ?? 0;
    seen.set(cell, nth + 1);
    const failedCount =
      o.language === "en"
        ? (opts.secondaryFailed?.[o.engine] ?? 0)
        : opts.failed === "all"
          ? PER_ENGINE
          : (opts.failed?.[o.engine] ?? 0);
    const failed = nth < failedCount;
    const notPresent = o.language === "en" ? 0 : (opts.notPresent?.[o.engine] ?? 0);
    const present = !failed && nth >= failedCount + notPresent;
    const channel = opts.channel?.[slot] ?? "ui-vendor";
    const mentions = present ? (opts.mentions ?? defaultMentions)(slot) : [];
    const answer = failed ? null : { present };
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
    plan: answered,
    captures,
    extractions,
    ...(opts.intentWeights === undefined ? {} : { intentWeights: opts.intentWeights }),
    ...(opts.languageShares === undefined ? {} : { languageShares: opts.languageShares }),
  };
}

export const REPORT = "fr_01JD3N7Q8ZK4R5T6V7W8X9Y0AB";

export function reportInput(
  opts: FixtureOptions = {},
  over: Partial<FreeReportInput> = {},
): FreeReportInput {
  return {
    reportId: REPORT,
    asOf: new Date("2026-11-19T15:00:00.000Z"),
    target: { entityKey: TARGET, displayName: "Clínica Sonrisas", entityKind: "business" },
    ...fixture(opts),
    ...over,
  };
}

export const rival = (k: number): EntityKey => `place:rival${k}`;

/** The target first in even answers; rival k recommended second in every (k + 2)-th answer. */
export const ladder = (slot: number): ResolvedMention[] => [
  ...(slot % 2 === 0 ? [mention({ entityKey: TARGET })] : []),
  ...Array.from({ length: 7 }, (_, k) => k)
    .filter((k) => slot % (k + 2) === 0)
    .map((k) => mention({ entityKey: rival(k), ordinal: 2 })),
];
