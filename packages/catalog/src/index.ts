import "server-only";

export { ARCHETYPE_SCOPES, ARCHETYPE_SLATES, registerFor } from "./archetypes";
export { CANARY_GEOS, CANARY_ID, type CanarySet, type CanaryVariant, canarySet } from "./canary";
export {
  type CategoryNames,
  categoryTerms,
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
  widerGeos,
} from "./geo/resolve";
export {
  agree,
  type Gender,
  type GenderedNoun,
  type Noun,
  nounGenders,
  nounText,
} from "./grammar";
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
  type DecideLanguagesInput,
  decideLanguages,
  type LanguageDecision,
  type LanguageMix,
  type LanguageMixDegraded,
  type LanguageMixSource,
  SECOND_LANGUAGE_MIN_SHARE,
  type SecondLanguage,
  type SecondLanguageReason,
  secondLanguageOf,
  unmeasuredMix,
} from "./language-mix";
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
