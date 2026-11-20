import { mainLanguage } from "@reranker/i18n/countries";
import { AppError } from "@reranker/schema";
import type {
  GeoTarget,
  Intent,
  IntentId,
  IntentSet,
  MeasurementLanguage,
  ParaphraseFormat,
  PromptVariant,
  QuestionScope,
} from "@reranker/schema/measurement";
import { agree, type Noun, nounText } from "./grammar";
import { promptSha256, variantId } from "./hash";
import { countryName, placeName } from "./language";

export type InstantiateContext = {
  place: string | null;
  zone: string | null;
  country: string;
  noun: Noun;
  /** The template's language: how its words agree with the noun. */
  language: MeasurementLanguage;
  business?: string;
};

const PLACEHOLDER = /\{([^{}]*)\}/g;

/**
 * Fills {lugar}, {zona}, {país}, {sustantivo} and {business}, after the words that agree with the
 * noun; any placeholder left unfilled is a bug.
 */
export function instantiate(template: string, ctx: InstantiateContext): string {
  const values = new Map<string, string | null | undefined>([
    ["lugar", ctx.place],
    ["zona", ctx.zone],
    ["país", ctx.country],
    ["sustantivo", nounText(ctx.noun)],
    ["business", ctx.business],
  ]);
  const stray = template.replace(PLACEHOLDER, "");
  if (stray.includes("{") || stray.includes("}")) {
    throw new AppError("internal", { detail: `unbalanced braces in template: ${template}` });
  }
  return agree(template, ctx.noun, ctx.language).replace(PLACEHOLDER, (match, name: string) => {
    const value = values.get(name);
    if (!value) throw new AppError("internal", { detail: `unfilled placeholder ${match}` });
    return value;
  });
}

/** A pool entry before its text is filled: sampling only needs these, so prompts are built for the drawn few. */
export type VariantCandidate = {
  paraphraseId: string;
  personaId: string | null;
  format: ParaphraseFormat;
  isCanonical: boolean;
  text: string;
  preamble: string | null;
};

export function findIntent(set: IntentSet, intentId: IntentId): Intent {
  const intent = set.intents.find((i) => i.intentId === intentId);
  if (!intent)
    throw new AppError("internal", { detail: `${intentId} is not in ${set.manifest.id}` });
  return intent;
}

export function variantPool(set: IntentSet, intent: Intent): VariantCandidate[] {
  const personas = set.personas.filter((p) => p.categoryKey === intent.categoryKey);
  const pool = set.paraphrases
    .filter((p) => p.intentId === intent.intentId)
    .flatMap(({ paraphraseId, format, text }) => [
      {
        paraphraseId,
        personaId: null,
        format,
        isCanonical: paraphraseId === intent.canonicalParaphraseId,
        text,
        preamble: null,
      },
      ...personas.map((p) => ({
        paraphraseId,
        personaId: p.personaId,
        format,
        isCanonical: false,
        text,
        preamble: p.preamble,
      })),
    ]);
  if (pool.filter((c) => c.isCanonical).length !== 1) {
    throw new AppError("internal", { detail: `${intent.intentId} needs exactly one canonical` });
  }
  return pool;
}

/** Names in the language asked; a national question names no place, so it needs none. */
export function variantContext(
  geo: GeoTarget,
  scope: QuestionScope,
  neighborhood: string | null,
  noun: Noun,
  language: MeasurementLanguage,
): InstantiateContext {
  return {
    place: scope === "local" ? placeName(geo, language) : null,
    zone: neighborhood,
    country: countryName(geo.country, language),
    noun,
    language,
  };
}

/** The language every intent of a set is asked in; a set never mixes languages. */
export function setLanguage(set: IntentSet): MeasurementLanguage {
  const languages = new Set(set.intents.map((i) => i.language));
  const [language] = languages;
  if (languages.size !== 1 || language === undefined) {
    throw new AppError("internal", { detail: `${set.manifest.id} mixes languages` });
  }
  return language;
}

export function materialize(
  intentId: IntentId,
  candidate: VariantCandidate,
  geo: GeoTarget,
  ctx: InstantiateContext,
  language: MeasurementLanguage,
): PromptVariant {
  const { paraphraseId, personaId, format, isCanonical, text, preamble } = candidate;
  const question = instantiate(text, ctx);
  const prompt = preamble === null ? question : `${instantiate(preamble, ctx)} ${question}`;
  const named = language === mainLanguage(geo.country) ? {} : { language };
  return {
    variantId: variantId({ intentId, paraphraseId, personaId, geoKey: geo.key, ...named }),
    intentId,
    paraphraseId,
    personaId,
    format,
    isCanonical,
    prompt,
    promptSha256: promptSha256(prompt),
  };
}

/**
 * Every variant of an intent at a place: each paraphrase without persona and with each persona of
 * its category. The noun fills {sustantivo}: a set is shared by every business of its category,
 * and a web-only store names what it sells.
 */
export function buildVariants(
  set: IntentSet,
  intentId: IntentId,
  geo: GeoTarget,
  neighborhood: string | null,
  noun: Noun,
): PromptVariant[] {
  const intent = findIntent(set, intentId);
  const ctx = variantContext(geo, intent.scope, neighborhood, noun, intent.language);
  return variantPool(set, intent).map((c) => materialize(intentId, c, geo, ctx, intent.language));
}
