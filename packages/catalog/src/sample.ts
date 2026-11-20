import { AppError, type CaptureProvider, type EngineId } from "@reranker/schema";
import type {
  GeoTarget,
  Intent,
  IntentSet,
  MeasurementPlan,
  PlannedObservation,
  QuestionScope,
} from "@reranker/schema/measurement";
import { type Rng, rngFromSeed } from "@reranker/stats";
import { geoForEngine } from "./geo/effects";
import { sha256Hex } from "./hash";
import { materialize, type VariantCandidate, variantContext, variantPool } from "./variants";

export type PlanMeasurementInput = {
  intentSet: IntentSet;
  geo: GeoTarget;
  scope: QuestionScope;
  neighborhood: string | null;
  /** The business category's noun, which fills {sustantivo}. */
  noun: string;
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
function drawVariants(
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

/**
 * The free report's paired design: the same drawn variants of each intent go to every engine, one
 * run each, seeded by sha256(reportId) so the plan is reproducible from the report alone.
 */
export function planMeasurement(input: PlanMeasurementInput): MeasurementPlan {
  const { intentSet, geo, scope, neighborhood, noun, reportId } = input;
  const intents = input.intents ?? 5;
  const variantsPerIntent = input.variantsPerIntent ?? 8;
  if (intentSet.manifest.scope !== scope) {
    throw internal(`${intentSet.manifest.id} is a ${intentSet.manifest.scope} set, not ${scope}`);
  }

  const engines = input.engines.flatMap((engine) => {
    const provider = input.providers?.[engine] ?? DEFAULT_PROVIDERS[engine];
    const geoDeclared = geoForEngine(engine, geo, scope, { provider });
    return geoDeclared ? [{ engine, provider, geoDeclared }] : [];
  });
  if (engines.length === 0) throw internal(`no planned engine is offered in ${geo.country}`);

  const seed = sha256Hex(reportId);
  const rng = rngFromSeed(seed);
  const ctx = variantContext(geo, neighborhood, noun);
  const observations: PlannedObservation[] = [];
  for (const intent of pickIntents(intentSet, neighborhood, intents)) {
    for (const candidate of drawVariants(variantPool(intentSet, intent), variantsPerIntent, rng)) {
      const v = materialize(intent.intentId, candidate, geo, ctx);
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
          variantId: v.variantId,
          promptSha256: v.promptSha256,
          isCanonical: v.isCanonical,
        });
      }
    }
  }

  return {
    intentSet: intentSet.manifest,
    geo,
    scope,
    seed,
    design: { intents, variantsPerIntent, runsPerVariant: 1 },
    observations,
  };
}
