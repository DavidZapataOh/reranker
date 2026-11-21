import { AppError } from "@reranker/schema";
import type { GeoKey, PromptVariant, QuestionScope } from "@reranker/schema/measurement";
import { seedCategories } from "./categories";
import { getGeo } from "./geo/resolve";
import { type IntentSetId, intentSetId } from "./hash";
import { seedIntentSets, seedSetFor } from "./seal";
import { type FrozenSeed, loadSeed } from "./seed/load";
import { materialize, variantContext, variantPool } from "./variants";

/** The rule and the seed version are part of the id: changing either is canary@4. */
export const CANARY_ID = "canary@3";
const CANARY_SEED_VERSION = "2026.11.0";
const CANARY_SIZE = 25;
/** Bogotá and Medellín, fixed so the daily series stays comparable. */
export const CANARY_GEOS = ["co-c1003659", "co-c1003654"] as const;
// A web-only store's questions name what it sells; "tienda de ropa online" is the store search
// Colombians put to AI Overviews most.
const STORE_NOUN = "ropa";

export type CanaryVariant = PromptVariant & { geoKey: GeoKey; scope: QuestionScope };

export type CanarySet = {
  id: typeof CANARY_ID;
  version: string;
  /** The seed version's intent set, which every canary question belongs to. */
  intentSetId: IntentSetId;
  variants: CanaryVariant[];
  geos: typeof CANARY_GEOS;
};

const nouns = new Map<string, string>(seedCategories().map((c) => [c.key, c.noun ?? STORE_NOUN]));

/**
 * The canonical question of each free-report intent asked in Colombian Spanish, zone ones left out
 * since the canary has no neighborhood, in the catalog's category and intent order: the first 25,
 * in each canary city.
 */
export function canaryFrom(seed: FrozenSeed): CanarySet {
  const sets = seedIntentSets(seed);
  const picks = seed.catalog.categories.flatMap((category) => {
    const set = seedSetFor(sets, {
      categoryKey: category.key,
      scope: category.defaultScope,
      registerProfile: "co",
      language: "es",
    });
    if (!set) return [];
    return set.intents
      .filter((intent) => intent.freeReport && intent.kind !== "zone")
      .map((intent) => ({ set, intent }));
  });
  if (picks.length < CANARY_SIZE) {
    throw new AppError("internal", {
      detail: `seed ${seed.version} has ${picks.length} canary questions, not ${CANARY_SIZE}`,
    });
  }
  const variants = CANARY_GEOS.flatMap((geoKey) => {
    const geo = getGeo(geoKey);
    return picks.slice(0, CANARY_SIZE).map(({ set, intent }) => {
      const canonical = variantPool(set, intent).find((c) => c.isCanonical);
      if (!canonical) throw new AppError("internal", { detail: `${intent.intentId} canonical` });
      const noun = nouns.get(intent.categoryKey) ?? STORE_NOUN;
      const ctx = variantContext(geo, intent.scope, null, noun, "es");
      return {
        ...materialize(intent.intentId, canonical, geo, ctx, "es"),
        geoKey,
        scope: intent.scope,
      };
    });
  });
  return {
    id: CANARY_ID,
    version: seed.version,
    intentSetId: intentSetId(seed.contentHash),
    variants,
    geos: CANARY_GEOS,
  };
}

let canary: CanarySet | undefined;

/** canary@3 over the seed version it was defined on, whatever newer version ships. */
export function canarySet(): CanarySet {
  canary ??= canaryFrom(loadSeed(CANARY_SEED_VERSION));
  return canary;
}
