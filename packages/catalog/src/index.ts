import "server-only";

export { ARCHETYPE_SCOPES, ARCHETYPE_SLATES, registerFor } from "./archetypes";
export { CANARY_GEOS, CANARY_ID, type CanarySet, type CanaryVariant, canarySet } from "./canary";
export {
  type CategoryNames,
  placesTypeArchetype,
  placesTypeLabel,
  type SeedCategory,
  seedCategories,
} from "./categories";
export {
  type ChatgptCityEffect,
  chatgptCityEffect,
  type GeoForEngineOptions,
  geoForEngine,
} from "./geo/effects";
export {
  cityDisplayName,
  getGeo,
  type ResolveGeoInput,
  resolveGeo,
  spokenPlaceName,
} from "./geo/resolve";
export { agree, type Gender, type GenderedNoun, type Noun, nounText } from "./grammar";
export {
  contentHash,
  type IntentSetId,
  intentSetId,
  jcs,
  promptSha256,
  sha256Hex,
  type VariantId,
  variantId,
} from "./hash";
export {
  currentSeedCatalog,
  getIntent,
  getVariant,
  type ResolveIntentSetInput,
  resolveIntentSet,
} from "./intent-sets";
export {
  countryLanguage,
  countryName,
  type LanguageGap,
  MeasurementLanguageError,
  placeName,
  placeTerm,
} from "./language";
export {
  type PlanMeasurementInput,
  planMeasurement,
  type SecondaryLanguage,
} from "./sample";
export {
  brandTemplates,
  canonicalTemplate,
  type FallbackIntent,
  fallbackTemplates,
  type PlaceholderShape,
  placeholderShape,
  TEMPLATE_LANGUAGES,
  templatesVersion,
} from "./templates";
export { buildVariants, type InstantiateContext, instantiate } from "./variants";
