import { AppError, type CaptureProvider, type EngineId } from "@reranker/schema";
import type {
  EngineGeo,
  GeoTarget,
  Intent,
  IntentSet,
  MeasurementLanguage,
  MeasurementPlan,
  PlannedObservation,
  QuestionScope,
} from "@reranker/schema/measurement";
import { type Rng, rngFromSeed } from "@reranker/stats";
import { geoForEngine } from "./geo/effects";
import type { Noun } from "./grammar";
import { sha256Hex } from "./hash";
import { countryLanguage } from "./language";
import { requireTemplates } from "./templates";
import {
  materialize,
  setLanguage,
  type VariantCandidate,
  variantContext,
  variantPool,
} from "./variants";

/** A second language: its own set, written in it, and the noun as people asking in it say it. */
export type SecondaryLanguage = {
  language: MeasurementLanguage;
  intentSet: IntentSet;
  noun: Noun;
};

export type PlanMeasurementInput = {
  intentSet: IntentSet;
  geo: GeoTarget;
  scope: QuestionScope;
  neighborhood: string | null;
  /** The business category's noun, which fills {sustantivo}. */
  noun: Noun;
  /** The language `intentSet` and `noun` are in; the country's main language by default. */
  language?: MeasurementLanguage;
  /** Asked on half the sample of the main language, never less, so its result stands alone. */
  secondary?: SecondaryLanguage;
  engines: readonly EngineId[];
  reportId: string;
  providers?: Partial<Record<EngineId, CaptureProvider>>;
  intents?: number;
  variantsPerIntent?: number;
};

// The free report's providers. Bright Data's ChatGPT scrapes took 82 s to over 234 s, past the
// free report's budget, so ChatGPT goes through DataForSEO here; a paid report passes
// `providers: { chatgpt: "brightdata" }` to ask it from the city's coordinate.
const DEFAULT_PROVIDERS: Readonly<Record<EngineId, CaptureProvider>> = {
  chatgpt: "dataforseo",
  perplexity: "brightdata",
  gemini: "dataforseo",
  "google-ai-overview": "dataforseo",
  "google-ai-mode": "dataforseo",
};

const MAX_PER_PERSONA = 2;

const internal = (detail: string) => new AppError("internal", { detail });

// Free-report intents in set order, then the rest; a zone question needs a neighborhood, and
// brand questions are measured apart.
function pickIntents(set: IntentSet, neighborhood: string | null, count: number): Intent[] {
  const usable = set.intents.filter(
    (i) => i.kind !== "brand" && (i.kind !== "zone" || neighborhood !== null),
  );
  const ordered = [...usable.filter((i) => i.freeReport), ...usable.filter((i) => !i.freeReport)];
  if (ordered.length < count) {
    throw internal(`${set.manifest.id} has ${ordered.length} plannable intents, ${count} needed`);
  }
  return ordered.slice(0, count);
}

/**
 * The canonical, then draws without replacement over the eligible rest: a new paraphrase, at most
 * two per persona, and the last draw reserved for a variant without persona if none came earlier.
 * Uniform among eligible candidates at each step, so variants alike under the constraints are
 * equally likely.
 */
export function drawVariants(
  pool: readonly VariantCandidate[],
  count: number,
  rng: Rng,
): VariantCandidate[] {
  if (pool.length < count) throw internal(`a pool of ${pool.length} cannot give ${count} variants`);
  const canonical = pool.find((c) => c.isCanonical) as VariantCandidate;
  const drawn = [canonical];
  const usedParaphrases = new Set([canonical.paraphraseId]);
  const perPersona = new Map<string, number>();
  let withoutPersona = 0;
  const eligible: VariantCandidate[] = [];
  for (let slot = 1; slot < count; slot++) {
    const needsWithoutPersona = slot === count - 1 && withoutPersona === 0;
    eligible.length = 0;
    for (const c of pool) {
      if (usedParaphrases.has(c.paraphraseId)) continue;
      if (c.personaId === null) eligible.push(c);
      else if (!needsWithoutPersona && (perPersona.get(c.personaId) ?? 0) < MAX_PER_PERSONA) {
        eligible.push(c);
      }
    }
    const pick = eligible[Math.floor(rng.next() * eligible.length)];
    if (!pick) throw internal(`the pool runs out of eligible variants at draw ${slot + 1}`);
    drawn.push(pick);
    usedParaphrases.add(pick.paraphraseId);
    if (pick.personaId === null) withoutPersona++;
    else perPersona.set(pick.personaId, (perPersona.get(pick.personaId) ?? 0) + 1);
  }
  return drawn;
}

type PlannedEngine = { engine: EngineId; provider: CaptureProvider; geoDeclared: EngineGeo };

type LanguageSample = {
  language: MeasurementLanguage;
  intentSet: IntentSet;
  noun: Noun;
  design: MeasurementPlan["design"];
};

function checkSet(set: IntentSet, scope: QuestionScope, language: MeasurementLanguage): void {
  // A language is measured only once its fallback templates exist, whatever set is passed in.
  requireTemplates(language);
  if (set.manifest.scope !== scope) {
    throw internal(`${set.manifest.id} is a ${set.manifest.scope} set, not ${scope}`);
  }
  if (setLanguage(set) !== language) throw internal(`${set.manifest.id} is not in ${language}`);
}

function observe(
  sample: LanguageSample,
  input: PlanMeasurementInput,
  engines: readonly PlannedEngine[],
  rng: Rng,
  observations: PlannedObservation[],
): void {
  const { language, intentSet, noun, design } = sample;
  const { geo, scope, neighborhood } = input;
  const ctx = variantContext(geo, scope, neighborhood, noun, language);
  for (const intent of pickIntents(intentSet, neighborhood, design.intents)) {
    const pool = variantPool(intentSet, intent);
    for (const candidate of drawVariants(pool, design.variantsPerIntent, rng)) {
      const v = materialize(intent.intentId, candidate, geo, ctx, language);
      for (const { engine, provider, geoDeclared } of engines) {
        observations.push({
          engine,
          provider,
          intentSetId: intentSet.manifest.id,
          intentId: v.intentId,
          paraphraseId: v.paraphraseId,
          ...(v.personaId === null ? {} : { personaId: v.personaId }),
          geoKey: geo.key,
          geoDeclared,
          runIndex: 0,
          promptText: v.prompt,
          language,
          variantId: v.variantId,
          promptSha256: v.promptSha256,
          isCanonical: v.isCanonical,
        });
      }
    }
  }
}

/**
 * The free report's paired design: the same drawn variants of each intent go to every engine, one
 * run each, seeded by sha256(reportId) so the plan is reproducible from the report alone. A second
 * language draws after the main one, from the same seed, so adding it never changes the main
 * language's questions.
 */
export function planMeasurement(input: PlanMeasurementInput): MeasurementPlan {
  const { intentSet, geo, scope, noun, reportId, secondary } = input;
  const language = input.language ?? countryLanguage(geo.country);
  const design = {
    intents: input.intents ?? 5,
    variantsPerIntent: input.variantsPerIntent ?? 8,
    runsPerVariant: 1 as const,
  };
  checkSet(intentSet, scope, language);
  if (secondary) {
    if (secondary.language === language) throw internal(`${language} is already the main language`);
    checkSet(secondary.intentSet, scope, secondary.language);
  }

  // Declared locations label the report, which is written in Spanish whatever the question's
  // language.
  const engines = input.engines.flatMap((engine) => {
    const provider = input.providers?.[engine] ?? DEFAULT_PROVIDERS[engine];
    const geoDeclared = geoForEngine(engine, geo, scope, { provider });
    return geoDeclared ? [{ engine, provider, geoDeclared }] : [];
  });
  if (engines.length === 0) throw internal(`no planned engine is offered in ${geo.country}`);

  const seed = sha256Hex(reportId);
  const rng = rngFromSeed(seed);
  const observations: PlannedObservation[] = [];
  observe({ language, intentSet, noun, design }, input, engines, rng, observations);
  const second = secondary && {
    ...secondary,
    design: { ...design, variantsPerIntent: Math.ceil(design.variantsPerIntent / 2) },
  };
  if (second) observe(second, input, engines, rng, observations);

  return {
    intentSet: intentSet.manifest,
    geo,
    scope,
    seed,
    design,
    language,
    ...(second
      ? {
          secondary: {
            language: second.language,
            intentSet: second.intentSet.manifest,
            design: second.design,
          },
        }
      : {}),
    observations,
  };
}
