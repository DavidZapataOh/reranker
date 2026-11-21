import {
  ARCHETYPE_SCOPES,
  countryLanguage,
  type Gender,
  placesTypeArchetype,
  placesTypeLabel,
  registerFor,
  type SeedCategory,
  seedCategories,
} from "@reranker/catalog";
import type {
  BusinessCandidate,
  BusinessCategory,
  CategoryArchetype,
  MeasurementLanguage,
  QuestionScope,
} from "@reranker/schema/measurement";

/**
 * A category named in the language the business is measured in. `nounGender` is set in the
 * languages whose question templates agree with the noun, and null in the others.
 */
export type InferredCategory = BusinessCategory & {
  confidence: number;
  language: MeasurementLanguage;
  nounGender: Gender | null;
};

const SEED_CONFIDENCE = 0.95;
const PLACES_TYPE_CONFIDENCE = 0.9;
// Table A types that name a kind of place, not what the business sells.
const GENERIC_TYPES = new Set(["store", "service", "establishment", "point_of_interest"]);
// When the country speaks none of the measured languages the measurement is refused later; the
// category still needs a name until then.
const HOUSE_LANGUAGE: MeasurementLanguage = "es";

const seedByType = new Map<string, Readonly<SeedCategory>>(
  seedCategories().flatMap((seed) => seed.placesTypes.map((type) => [type, seed] as const)),
);

function languageOf(c: BusinessCandidate): MeasurementLanguage {
  if (c.geo === null) return HOUSE_LANGUAGE;
  try {
    return countryLanguage(c.geo.country);
  } catch {
    return HOUSE_LANGUAGE;
  }
}

const capitalize = (text: string, language: MeasurementLanguage) =>
  text.charAt(0).toLocaleUpperCase(language) + text.slice(1);
const uncapitalize = (text: string, language: MeasurementLanguage) =>
  text.charAt(0).toLocaleLowerCase(language) + text.slice(1);

/** The seed's reviewed noun in `language`; null where the business's product names it. */
function seedNoun(
  seed: Readonly<SeedCategory>,
  language: MeasurementLanguage,
): { text: string; gender: Gender | null } | null {
  if (language === "es") return seed.noun === null ? null : { text: seed.noun, gender: null };
  const noun = seed.languages[language].noun;
  if (noun === null) return null;
  return typeof noun === "string" ? { text: noun, gender: null } : noun;
}

function allowedScope(archetype: CategoryArchetype, wanted: QuestionScope): QuestionScope {
  const scopes = ARCHETYPE_SCOPES[archetype];
  return scopes.includes(wanted) ? wanted : (scopes[0] as QuestionScope);
}

function category(
  fields: Omit<InferredCategory, "register" | "scope"> & { scope?: QuestionScope },
): InferredCategory {
  const scope = fields.scope ?? (fields.archetype === "online_national" ? "national" : "local");
  return {
    ...fields,
    scope: allowedScope(fields.archetype, scope),
    register: registerFor(fields.archetype),
  };
}

function fromSeed(
  seed: Readonly<SeedCategory>,
  noun: { text: string; gender: Gender | null },
  language: MeasurementLanguage,
  confidence: number,
): InferredCategory {
  return category({
    key: seed.key,
    source: "seed",
    label: capitalize(noun.text, language),
    noun: noun.text,
    nounGender: noun.gender,
    archetype: seed.archetype,
    scope: seed.defaultScope,
    placesTypes: [...seed.placesTypes],
    confidence,
    language,
  });
}

function typesOf(c: BusinessCandidate): string[] {
  const { primaryType, types } = c.places ?? { primaryType: null, types: [] };
  return [...new Set(primaryType ? [primaryType, ...types] : types)];
}

/** The type's own name: Google's label in Spanish, its English type name everywhere else. */
function placesTypeName(c: BusinessCandidate, type: string, language: MeasurementLanguage) {
  if (language !== "es") return capitalize(type.replaceAll("_", " "), language);
  const google = type === c.places?.primaryType ? c.places.primaryTypeDisplayName : null;
  return google || placesTypeLabel(type);
}

function fromPlacesType(
  c: BusinessCandidate,
  type: string,
  archetype: CategoryArchetype,
  language: MeasurementLanguage,
  confidence: number,
  label = placesTypeName(c, type, language),
): InferredCategory | null {
  if (!label) return null;
  return category({
    key: `gen:places:${type}`,
    source: "places_type",
    label,
    noun: uncapitalize(label, language),
    nounGender: null,
    archetype,
    placesTypes: [type],
    confidence,
    language,
  });
}

/**
 * The category Places already tells: the reviewed seed in every language, then a specific
 * Table A type, named by Google's Spanish label, only for businesses measured in Spanish.
 * Null when the classifier has to name it.
 */
export function categoryByRules(
  c: BusinessCandidate,
  language: MeasurementLanguage = languageOf(c),
): InferredCategory | null {
  for (const type of typesOf(c)) {
    const seed = seedByType.get(type);
    const noun = seed && seedNoun(seed, language);
    if (seed && noun) return fromSeed(seed, noun, language, SEED_CONFIDENCE);
    if (GENERIC_TYPES.has(type)) continue;
    const archetype = placesTypeArchetype(type);
    if (archetype === null) continue;
    return language === "es"
      ? fromPlacesType(c, type, archetype, language, PLACES_TYPE_CONFIDENCE)
      : null;
  }
  return null;
}
