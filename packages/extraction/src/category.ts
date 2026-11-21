import {
  ARCHETYPE_SCOPES,
  type Gender,
  nounGenders,
  placesTypeArchetype,
  placesTypeLabel,
  registerFor,
  type SeedCategory,
  seedCategories,
} from "@reranker/catalog";
import type { SpendContext } from "@reranker/jobs";
import type {
  BusinessCandidate,
  BusinessCategory,
  CategoryArchetype,
  MeasurementLanguage,
  QuestionScope,
} from "@reranker/schema/measurement";
import { currentExtractorConfig, type ExtractorConfig } from "./config";
import { languageOfCountry } from "./language";
import { CLASSIFY_PROMPT_V1 } from "./prompts/classify.v1";
import { callerFor, paidCall } from "./providers/call";
import { type ClassifierOutput, ClassifierSchema } from "./schema";

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
const FALLBACK_CONFIDENCE = 0.5;
const NATIONAL_CONFIDENCE = 0.8;
const CLASSIFIER_MAX_OUTPUT_TOKENS = 512;
// Table A types that name a kind of place, not what the business sells.
const GENERIC_TYPES = new Set(["store", "service", "establishment", "point_of_interest"]);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const seedByType = new Map<string, Readonly<SeedCategory>>(
  seedCategories().flatMap((seed) => seed.placesTypes.map((type) => [type, seed] as const)),
);
const seedByKey = new Map(seedCategories().map((seed) => [seed.key as string, seed]));

function languageOf(c: BusinessCandidate): MeasurementLanguage {
  return languageOfCountry(c.geo?.country ?? null);
}

const capitalize = (text: string, language: MeasurementLanguage) =>
  text.charAt(0).toLocaleUpperCase(language) + text.slice(1);
// German capitalizes every noun, so a heading label is already the noun as written in a sentence.
const uncapitalize = (text: string, language: MeasurementLanguage) =>
  language === "de" ? text : text.charAt(0).toLocaleLowerCase(language) + text.slice(1);

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

function seedSynonym(seed: Readonly<SeedCategory>, language: MeasurementLanguage): string {
  const synonyms = language === "es" ? seed.synonyms : seed.languages[language].synonyms;
  return synonyms[0] ?? seed.key;
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

/** Google's label, asked in the business's language, when that is the one being named. */
function googleLabel(
  c: BusinessCandidate,
  label: string | null | undefined,
  language: MeasurementLanguage,
): string | null {
  return (language === languageOf(c) && label) || null;
}

/** The type's name in `language`: Google's label, else our reviewed Spanish one. */
function placesTypeName(c: BusinessCandidate, type: string, language: MeasurementLanguage) {
  const primary = type === c.places?.primaryType ? c.places.primaryTypeDisplayName : null;
  return googleLabel(c, primary, language) ?? (language === "es" ? placesTypeLabel(type) : null);
}

function fromPlacesType(
  type: string,
  archetype: CategoryArchetype,
  language: MeasurementLanguage,
  confidence: number,
  label: string | null,
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
 * Table A type named by Google in the business's language. Google gives no grammatical gender,
 * so in languages whose templates agree with the noun only the classifier can name a type
 * outside the seed. Null when the classifier has to name it.
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
    if (nounGenders(language).length > 0) return null;
    const label = placesTypeName(c, type, language);
    return fromPlacesType(type, archetype, language, PLACES_TYPE_CONFIDENCE, label);
  }
  return null;
}

/**
 * What is left when the rules gave nothing and the classifier cannot answer: the archetype of
 * Places' first business type, generic ones included, or an online store for a website. Without
 * a name in the language, a type keeps its English name; a gendered language then refuses it
 * where questions are built rather than asking with a wrong noun.
 */
function fallback(c: BusinessCandidate, language: MeasurementLanguage): InferredCategory {
  for (const type of typesOf(c)) {
    const archetype = placesTypeArchetype(type);
    if (archetype === null) continue;
    const label =
      googleLabel(c, c.places?.googleMapsTypeLabel, language) ??
      placesTypeName(c, type, language) ??
      capitalize(type.replaceAll("_", " "), language);
    const found = fromPlacesType(type, archetype, language, FALLBACK_CONFIDENCE, label);
    if (found) return { ...found, scope: allowedScope(archetype, "local") };
  }
  const store = seedByKey.get("online_store") as Readonly<SeedCategory>;
  const name = seedSynonym(store, language);
  return {
    ...fromSeed(store, { text: name, gender: null }, language, FALLBACK_CONFIDENCE),
    placesTypes: [],
  };
}

function slugOf(key: string): string | null {
  const slug = key
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length >= 2 && slug.length <= 40 && SLUG.test(slug) ? slug : null;
}

/** The classifier's answer as a category, or null when it breaks a rule the measurement needs. */
function fromClassifier(
  c: BusinessCandidate,
  out: ClassifierOutput,
  language: MeasurementLanguage,
): InferredCategory | null {
  const genders = nounGenders(language);
  const gender = genders.length === 0 ? null : out.nounGender;
  if (genders.length > 0 && (gender === null || !genders.includes(gender))) return null;
  const noun = out.noun.trim();
  const label = out.label.trim();
  if (noun === "" || label === "") return null;

  const website = c.kind === "website";
  const wantsNational =
    website ||
    out.archetype === "online_national" ||
    (out.scope === "national" && out.confidence >= NATIONAL_CONFIDENCE);
  // A business known only by its website has no premises to be asked about locally.
  const archetype =
    website && !ARCHETYPE_SCOPES[out.archetype].includes("national")
      ? "online_national"
      : out.archetype;
  const scope: QuestionScope = wantsNational ? "national" : "local";

  const seed = seedByKey.get(out.categoryKey);
  if (seed) {
    const reviewed = seedNoun(seed, language);
    return {
      ...fromSeed(seed, reviewed ?? { text: noun, gender }, language, out.confidence),
      ...(reviewed === null && { label }),
      scope: allowedScope(seed.archetype, scope),
    };
  }
  const slug = slugOf(out.categoryKey);
  if (slug === null) return null;
  return category({
    key: `gen:${slug}`,
    source: "inferred",
    label,
    noun,
    nounGender: gender,
    archetype,
    scope,
    placesTypes: typesOf(c).filter((t) => placesTypeArchetype(t) !== null),
    confidence: out.confidence,
    language,
  });
}

function classifierMessage(c: BusinessCandidate, language: MeasurementLanguage): string {
  return JSON.stringify({
    language,
    country: c.geo?.country ?? null,
    name: c.displayName,
    placesTypes: c.places?.types ?? [],
    primaryType: c.places?.primaryType ?? null,
    primaryTypeLabel: c.places?.primaryTypeDisplayName ?? null,
    googleMapsTypeLabel: c.places?.googleMapsTypeLabel ?? null,
    website: c.website ?? null,
  });
}

/**
 * The category and scope a business is measured with, named in its measurement language
 * (`language`, else its country's). Rules first; the classifier only when Places does not say.
 * Never throws: a classifier that fails, answers late or breaks a rule leaves the rules' or
 * Places' archetype at low confidence, and whatever the call cost is settled by `paidCall`.
 */
export async function inferCategory(
  c: BusinessCandidate,
  opts: { spend: SpendContext; config?: ExtractorConfig; language?: MeasurementLanguage },
): Promise<InferredCategory> {
  const language = opts.language ?? languageOf(c);
  const rules = categoryByRules(c, language);
  if (rules) return rules;

  const config = opts.config ?? currentExtractorConfig;
  const model = config.models.classifier;
  const timeoutMs = config.timeoutsMs.classifier;
  const classified = paidCall(
    callerFor(model),
    {
      model,
      system: CLASSIFY_PROMPT_V1,
      user: classifierMessage(c, language),
      schema: ClassifierSchema,
      schemaName: "category",
      maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
    },
    { timeoutMs, retries: 0, spend: opts.spend },
  ).then(
    ({ output }) => fromClassifier(c, output, language),
    () => null,
  );
  // Waiting for a provider slot is not bounded by the call's own deadline.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const found = await Promise.race([classified, late]).finally(() => clearTimeout(timer));
  return found ?? fallback(c, language);
}
