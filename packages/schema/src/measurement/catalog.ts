import { CaptureProvider, EngineId } from "../domain";
import { CountryCode } from "../primitives";
import { z } from "../z";

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const Slug = z.string().regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/);

export const GeoLevel = z.enum(["city", "region", "country"]);
export type GeoLevel = z.infer<typeof GeoLevel>;

export const QuestionScope = z.enum(["local", "national"]);
export type QuestionScope = z.infer<typeof QuestionScope>;

// 'mx' (country), 'mx-r…' (region), 'co-c…' (city); ids come from the DataForSEO location source.
export const GeoKey = z.string().regex(/^[a-z]{2}(-[rc][0-9a-z]+)?$/);
export type GeoKey = z.infer<typeof GeoKey>;

export const GeoTarget = z.object({
  key: GeoKey,
  level: GeoLevel,
  country: CountryCode,
  name: z.string().min(1),
  regionName: z.string().min(1).nullable(),
  center: z
    .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
    .nullable(),
  // The most precise DataForSEO location: the city, else its region, else the country.
  dataforseo: z.object({
    locationCode: z.number().int().positive(),
    level: GeoLevel,
    label: z.string().min(1),
  }),
  enrichment: z
    .object({
      divipola: z.object({
        municipalityCode: z.string().regex(/^\d{5}$/),
        departmentCode: z.string().regex(/^\d{2}$/),
      }),
    })
    .nullable(),
  geoDataHash: Sha256Hex,
});
export type GeoTarget = z.infer<typeof GeoTarget>;

// What the report declares as the location each engine was asked from.
export const EngineGeo = z.object({ level: GeoLevel, label: z.string().min(1) });
export type EngineGeo = z.infer<typeof EngineGeo>;

// Places API (New) `addressComponents[]` item.
export const PlacesAddressComponent = z.object({
  longText: z.string(),
  shortText: z.string(),
  types: z.array(z.string()),
  languageCode: z.string().optional(),
});
export type PlacesAddressComponent = z.infer<typeof PlacesAddressComponent>;

export const CategoryArchetype = z.enum([
  "health",
  "beauty_wellness",
  "lodging",
  "food",
  "home_auto_services",
  "local_retail",
  "professional_services",
  "real_estate",
  "education",
  "online_national",
]);
export type CategoryArchetype = z.infer<typeof CategoryArchetype>;

export const SeedCategoryKey = z.enum([
  "dental_clinic",
  "restaurant",
  "hotel",
  "car_repair",
  "real_estate_agency",
  "online_store",
]);
export type SeedCategoryKey = z.infer<typeof SeedCategoryKey>;

// 'gen:places:bakery' for a Places type, 'gen:cafe-de-origen' for an inferred category.
const GeneratedCategoryKey = z.templateLiteral([
  "gen:",
  z.string().regex(/^[a-z0-9]+(?:[:_-][a-z0-9]+)*$/),
]);
export const CategoryKey = z.union([SeedCategoryKey, GeneratedCategoryKey]);
export type CategoryKey = z.infer<typeof CategoryKey>;

export const BusinessCategory = z.object({
  key: CategoryKey,
  source: z.enum(["seed", "places_type", "inferred"]),
  label: z.string().min(1),
  noun: z.string().min(1),
  archetype: CategoryArchetype,
  scope: QuestionScope,
  register: z.enum(["tu", "usted"]),
  placesTypes: z.array(z.string()),
});
export type BusinessCategory = z.infer<typeof BusinessCategory>;

export const IntentKind = z.enum([
  "discovery",
  "specialty",
  "zone",
  "price",
  "urgency",
  "trust",
  "insurance_or_payment",
  "ranking",
  "brand",
]);
export type IntentKind = z.infer<typeof IntentKind>;

export const ParaphraseFormat = z.enum(["open_question", "list_request", "keyword", "constraint"]);
export type ParaphraseFormat = z.infer<typeof ParaphraseFormat>;

export const IntentSetKind = z.enum(["seed", "generated", "template"]);
export type IntentSetKind = z.infer<typeof IntentSetKind>;

// Sets never mix speech profiles: Colombian businesses get 'co', everyone else 'neutral'.
export const RegisterProfile = z.enum(["neutral", "co"]);
export type RegisterProfile = z.infer<typeof RegisterProfile>;

export const IntentSetId = z.templateLiteral(["is_", z.string().regex(/^[0-9a-f]{16}$/)]);
export type IntentSetId = z.infer<typeof IntentSetId>;

export const IntentId = z.templateLiteral([CategoryKey, ".", Slug]);
export type IntentId = z.infer<typeof IntentId>;

export const VariantId = z.templateLiteral(["pv_", z.string().regex(/^[0-9a-f]{16}$/)]);
export type VariantId = z.infer<typeof VariantId>;

export const IntentSetManifest = z.object({
  id: IntentSetId,
  kind: IntentSetKind,
  version: z.string().min(1),
  categoryKey: CategoryKey,
  scope: QuestionScope,
  registerProfile: RegisterProfile,
  contentHash: Sha256Hex,
  merkleRoot: Sha256Hex,
  variantCount: z.number().int().nonnegative(),
  generatorConfigHash: Sha256Hex.nullable(),
  generators: z.literal([0, 1, 2]),
});
export type IntentSetManifest = z.infer<typeof IntentSetManifest>;

export const Intent = z.object({
  intentId: IntentId,
  intentSetId: IntentSetId,
  categoryKey: CategoryKey,
  scope: QuestionScope,
  kind: IntentKind,
  slug: Slug,
  labelKey: z.string().min(1).nullable(),
  canonicalText: z.string().min(1),
  canonicalParaphraseId: z.string().min(1),
  demandWeight: z.number().nonnegative(),
  freeReport: z.boolean(),
  language: z.literal("es"),
  registerProfile: RegisterProfile,
});
export type Intent = z.infer<typeof Intent>;

export const Paraphrase = z.object({
  paraphraseId: z.string().min(1),
  intentId: IntentId,
  text: z.string().min(1),
  format: ParaphraseFormat,
  generator: z.enum(["openai", "gemini", "template", "human"]),
  humanReviewed: z.boolean(),
});
export type Paraphrase = z.infer<typeof Paraphrase>;

export const Persona = z.object({
  personaId: z.string().min(1),
  categoryKey: CategoryKey,
  preamble: z.string().min(1),
});
export type Persona = z.infer<typeof Persona>;

export const IntentSet = z.object({
  manifest: IntentSetManifest,
  intents: z.array(Intent).min(1),
  paraphrases: z.array(Paraphrase),
  personas: z.array(Persona),
});
export type IntentSet = z.infer<typeof IntentSet>;

export const PromptVariant = z.object({
  variantId: VariantId,
  intentId: IntentId,
  paraphraseId: z.string().min(1),
  personaId: z.string().min(1).nullable(),
  format: ParaphraseFormat,
  isCanonical: z.boolean(),
  // Exact text sent to the engine, placeholders filled.
  prompt: z.string().min(1),
  promptSha256: Sha256Hex,
});
export type PromptVariant = z.infer<typeof PromptVariant>;

// What capture needs per call; variant fields are optional for slots built outside the catalog.
export const PlannedSlot = z.object({
  engine: EngineId,
  provider: CaptureProvider,
  intentSetId: IntentSetId,
  intentId: IntentId,
  paraphraseId: z.string().min(1),
  personaId: z.string().min(1).optional(),
  geoKey: GeoKey,
  geoDeclared: EngineGeo,
  runIndex: z.number().int().min(0),
  promptText: z.string().min(1),
  variantId: VariantId.optional(),
  promptSha256: Sha256Hex.optional(),
  isCanonical: z.boolean().optional(),
});
export type PlannedSlot = z.infer<typeof PlannedSlot>;

export const PlannedObservation = PlannedSlot.extend({
  runIndex: z.literal(0),
  variantId: VariantId,
  promptSha256: Sha256Hex,
  isCanonical: z.boolean(),
});
export type PlannedObservation = z.infer<typeof PlannedObservation>;

export const MeasurementPlan = z.object({
  intentSet: IntentSetManifest,
  geo: GeoTarget,
  scope: QuestionScope,
  // sha256(reportId) as hex: the sampler seed.
  seed: Sha256Hex,
  design: z.object({
    intents: z.number().int().positive(),
    variantsPerIntent: z.number().int().positive(),
    runsPerVariant: z.literal(1),
  }),
  observations: z.array(PlannedObservation).min(1),
});
export type MeasurementPlan = z.infer<typeof MeasurementPlan>;
