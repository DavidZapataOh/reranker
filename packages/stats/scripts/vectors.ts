import type { EngineId } from "@reranker/schema";
import type {
  FreeReportStats,
  IntentSetManifest,
  MeasurementPlan,
  ResolvedMention,
} from "@reranker/schema/measurement";
import type { CitedSource } from "../src/citations";
import { methodology } from "../src/methodology";
import { computeFreeReportStats, type FreeReportInput } from "../src/report";
import {
  bilingualPlan,
  CONFIG,
  ENGINES,
  INTENTS,
  ladder,
  mention,
  PER_ENGINE,
  plan,
  RIVAL,
  reportInput,
  rival,
  TARGET,
} from "../test/fixtures/report-200";

export const VECTOR_NAMES = [
  "seed-local",
  "generated-national",
  "template",
  "one-engine",
  "invisible",
  "second-language",
] as const;
export type VectorName = (typeof VECTOR_NAMES)[number];

/** The input of `computeFreeReportStats` as JSON: `asOf` is its ISO 8601 string. */
export type VectorInput = Omit<FreeReportInput, "asOf"> & { asOf: string };

export interface Vector {
  methodologyVersion: string;
  methodologyHash: string;
  input: VectorInput;
  output: FreeReportStats;
}

export const reviveVector = (input: VectorInput): FreeReportInput => ({
  ...input,
  asOf: new Date(input.asOf),
});

// Plans now name the language they ask in; the statistics read none of it.
function planOf(over: {
  id: `is_${string}`;
  kind: IntentSetManifest["kind"];
  national?: boolean;
}): MeasurementPlan {
  const national = over.national === true;
  return {
    ...plan,
    language: "es",
    intentSet: {
      ...plan.intentSet,
      id: over.id,
      kind: over.kind,
      ...(over.kind === "seed" ? {} : { generatorConfigHash: "7".repeat(64), generators: 1 }),
      ...(national ? { scope: "national" as const } : {}),
    },
    ...(national
      ? {
          scope: "national" as const,
          geo: {
            ...plan.geo,
            key: "co",
            level: "country" as const,
            name: "Colombia",
            regionName: null,
          },
        }
      : {}),
    observations: plan.observations.map((o) => ({
      ...o,
      intentSetId: over.id,
      language: "es" as const,
      ...(national
        ? { geoKey: "co", geoDeclared: { level: "country" as const, label: "Colombia" } }
        : {}),
    })),
  };
}

const failAllBut = (engine: EngineId) =>
  Object.fromEntries(ENGINES.filter((e) => e !== engine).map((e) => [e, 40])) as Partial<
    Record<EngineId, number>
  >;

// Recommended without an order, named twice in one answer, chains and professionals, and more
// than ten rivals so some carry only a point value.
function templateMentions(slot: number): ResolvedMention[] {
  const target: ResolvedMention[] =
    slot % 3 === 0
      ? [mention({ entityKey: TARGET, ordinal: null })]
      : slot % 3 === 1
        ? [
            mention({ entityKey: TARGET, ordinal: 2 }),
            mention({ entityKey: TARGET, stance: "incidental", ordinal: 5 }),
          ]
        : [];
  return [
    ...target,
    mention({ entityKey: "chain:sonria", entityKind: "chain", name: "Sonría", ordinal: 1 }),
    ...(slot % 4 === 0
      ? [
          mention({
            entityKey: "name:dra gomez@co-c1003654",
            entityKind: "professional",
            ordinal: 3,
          }),
        ]
      : []),
    ...Array.from({ length: 12 }, (_, k) => k)
      .filter((k) => slot % (k + 2) === 1)
      .map((k) => mention({ entityKey: `place:t${k}`, ordinal: 4 + (k % 3) })),
  ];
}

const TARGET_INPUT = {
  entityKey: TARGET,
  displayName: "Clínica Sonrisas",
  entityKind: "business",
} as const;
const SITE = "https://www.clinicasonrisas.com.co";
const GROUNDING = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/";

// The target's site where it is recommended, a directory both share, sources only rivals get,
// a page cited twice with campaign tags, a retrieved page nobody cites, and Gemini's grounding
// redirects, one resolved and one not.
function citing(slot: number): CitedSource[] {
  const gemini = ENGINES[Math.floor(slot / PER_ENGINE)] === "gemini";
  return [
    ...(slot % 2 === 0 ? [{ url: `${SITE}/implantes`, cited: true }] : []),
    ...(slot % 3 === 0 ? [{ url: "https://www.doctoralia.co/clinica-sonrisas", cited: true }] : []),
    ...(slot % 2 === 1
      ? [
          { url: "https://www.topdoctors.com.co/rival/", cited: true },
          { url: "https://rival0.com.co/?utm_source=openai", cited: true },
          { url: "https://rival0.com.co/", cited: true },
        ]
      : []),
    ...(slot % 5 === 0 ? [{ url: "https://www.google.com/maps/place/Rival", cited: true }] : []),
    { url: "https://www.pullman.com.co/", cited: false },
    ...(gemini
      ? [
          {
            url: `${GROUNDING}a${slot}`,
            resolvedUrl: "https://es.wikipedia.org/wiki/Implante",
            cited: true,
          },
          { url: `${GROUNDING}b${slot}`, cited: true },
        ]
      : []),
  ];
}

function cases(): Record<VectorName, FreeReportInput> {
  const asOf = (h: number) => new Date(Date.UTC(2026, 10, 20, h));

  const seedLocal = reportInput(
    {
      failed: { chatgpt: 3 },
      notPresent: { gemini: 4 },
      sources: citing,
      mentions: (slot) => [
        ...ladder(slot),
        ...(slot % 4 === 0
          ? [mention({ entityKey: "platform:booking", entityKind: "platform", ordinal: null })]
          : []),
        mention({ entityKey: "web:directorio.co", entityKind: "directory_or_media", ordinal: 9 }),
      ],
    },
    {
      reportId: "fr_01JDB4Q7W2M8N3P5R6S9T0V1A1",
      target: { ...TARGET_INPUT, domains: ["clinicasonrisas.com.co", "instagram.com/sonrisas"] },
      asOf: asOf(14),
      plan: planOf({ id: "is_0123456789abcdef", kind: "seed" }),
    },
  );

  const generatedNational = reportInput(
    {
      failed: { perplexity: 25 },
      mentions: (slot) => [
        ...(slot % 2 === 1
          ? [mention({ entityKey: TARGET, stance: "incidental", ordinal: null })]
          : []),
        ...ladder(slot).map((m) =>
          m.entityKey === rival(6)
            ? { ...m, stance: "negative" as const, sentiment: "negative" as const }
            : m,
        ),
      ],
    },
    {
      reportId: "fr_01JDB4Q7W2M8N3P5R6S9T0V1A2",
      asOf: asOf(15),
      plan: planOf({ id: "is_aaaaaaaaaaaaaaaa", kind: "generated", national: true }),
    },
  );

  const template = reportInput(
    {
      notPresent: { "google-ai-mode": 2 },
      mentions: templateMentions,
      intentWeights: { [INTENTS[0] as string]: 3, [INTENTS[2] as string]: 2 },
    },
    {
      reportId: "fr_01JDB4Q7W2M8N3P5R6S9T0V1A3",
      asOf: asOf(16),
      plan: planOf({ id: "is_bbbbbbbbbbbbbbbb", kind: "template" }),
    },
  );
  // A retried slot: only the first succeeded attempt by captureId counts.
  template.captures.push({
    capture: {
      ...(template.captures[10]?.capture as FreeReportInput["captures"][number]["capture"]),
      id: "cap_0010_retry",
    },
    answer: { present: true, sources: [] },
  });
  template.extractions.push({
    ...(template.extractions[10] as FreeReportInput["extractions"][number]),
    captureId: "cap_0010_retry",
    configHash: CONFIG,
    mentions: [mention({ entityKey: RIVAL })],
  });

  const oneEngine = reportInput(
    { failed: failAllBut("gemini"), mentions: ladder },
    {
      reportId: "fr_01JDB4Q7W2M8N3P5R6S9T0V1A4",
      asOf: asOf(17),
      plan: planOf({ id: "is_0123456789abcdef", kind: "seed" }),
    },
  );

  // Gemini loses every answer of the first intent, so that stratum drops out of the engine.
  const invisible = reportInput(
    {
      failed: { gemini: 8 },
      sources: citing,
      mentions: (slot) => [
        ...(slot % 5 === 0
          ? [mention({ entityKey: TARGET, stance: "incidental", ordinal: null })]
          : []),
        mention({ entityKey: RIVAL }),
        ...(slot % 3 === 0 ? [mention({ entityKey: rival(0), ordinal: 2 })] : []),
      ],
    },
    {
      reportId: "fr_01JDB4Q7W2M8N3P5R6S9T0V1A5",
      target: { ...TARGET_INPUT, domains: [SITE] },
      asOf: asOf(18),
      plan: planOf({ id: "is_0123456789abcdef", kind: "seed" }),
    },
  );

  // English on the half-sample floor weighing 11 %: the target is rarer there and ranked lower,
  // and Perplexity loses too many English answers to count in English.
  const main = plan.observations.length;
  const secondLanguage = reportInput(
    {
      plan: bilingualPlan(),
      languageShares: { es: 0.89, en: 0.11 },
      failed: { chatgpt: 2 },
      secondaryFailed: { perplexity: 11, gemini: 3 },
      mentions: (slot) =>
        slot < main
          ? ladder(slot)
          : [
              ...(slot % 4 === 0 ? [mention({ entityKey: TARGET, ordinal: 3 })] : []),
              mention({ entityKey: rival(0), name: "Rival Dental Care" }),
              ...(slot % 3 === 0 ? [mention({ entityKey: "place:miami-smiles", ordinal: 2 })] : []),
            ],
    },
    { reportId: "fr_01JDB4Q7W2M8N3P5R6S9T0V1A6", asOf: asOf(19) },
  );

  return {
    "seed-local": seedLocal,
    "generated-national": generatedNational,
    template,
    "one-engine": oneEngine,
    invisible,
    "second-language": secondLanguage,
  };
}

export function buildVectors(): Array<[VectorName, Vector]> {
  return Object.entries(cases()).map(([name, input]) => [
    name as VectorName,
    {
      methodologyVersion: methodology.version,
      methodologyHash: methodology.hash,
      input: { ...input, asOf: input.asOf.toISOString() },
      output: computeFreeReportStats(input),
    },
  ]);
}
