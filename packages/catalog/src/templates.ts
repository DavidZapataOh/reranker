import { AppError, z } from "@reranker/schema";
import {
  CategoryArchetype,
  IntentKind,
  MeasurementLanguage,
  ParaphraseFormat,
  QuestionScope,
} from "@reranker/schema/measurement";
import de from "../data/templates/2026.11.0.de.json" with { type: "json" };
import en from "../data/templates/2026.11.0.en.json" with { type: "json" };
import fr from "../data/templates/2026.11.0.fr.json" with { type: "json" };
import it from "../data/templates/2026.11.0.it.json" with { type: "json" };
import es from "../data/templates/2026.11.0.json" with { type: "json" };
import pt from "../data/templates/2026.11.0.pt.json" with { type: "json" };
import { ARCHETYPE_SCOPES, ARCHETYPE_SLATES } from "./archetypes";
import { isAgreementGroup } from "./grammar";
import { MeasurementLanguageError } from "./language";

export type FallbackIntent = {
  kind: IntentKind;
  slug: string;
  canonical: string;
  paraphrases: Array<{ text: string; format: ParaphraseFormat }>;
};

const Intent = z.object({
  kind: IntentKind,
  slug: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
  canonical: z.string().min(1),
  paraphrases: z.array(z.object({ text: z.string().min(1), format: ParaphraseFormat })).min(8),
});

// Brand questions are measured apart and never enter the score.
const Brand = z.strictObject({
  "brand.trust": z.string().min(1),
  "brand.opinion": z.string().min(1),
});

const Templates = z.object({
  version: z.string().regex(/^\d{4}\.(?:0[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/),
  archetypes: z.record(
    CategoryArchetype,
    z.partialRecord(QuestionScope, z.array(Intent).length(6)),
  ),
  brand: Brand,
});
type Templates = z.infer<typeof Templates>;

// One file per language, <version>.<language>.json beside the Spanish <version>.json, each
// written from how people asking in that language phrase their questions, never translated.
// Placeholder names are the same in every language.
const TEMPLATES: Partial<Record<MeasurementLanguage, Templates>> = {
  es: Templates.parse({
    ...es,
    brand: {
      "brand.trust": "¿{business} en {lugar} es confiable?",
      "brand.opinion": "¿Qué opinas de {business}?",
    },
  }),
  en: Templates.parse(en),
  pt: Templates.parse(pt),
  fr: Templates.parse(fr),
  de: Templates.parse(de),
  it: Templates.parse(it),
};

/** The languages questions can be asked in today. */
export const TEMPLATE_LANGUAGES = MeasurementLanguage.options.filter((l) => l in TEMPLATES);

function templatesFor(language: MeasurementLanguage): Templates {
  const templates = TEMPLATES[language];
  if (!templates) {
    throw new MeasurementLanguageError(language, "no_templates", `no ${language} templates`);
  }
  return templates;
}

/** Refuses a language whose templates have not landed: it is never asked in another one. */
export function requireTemplates(language: MeasurementLanguage): void {
  templatesFor(language);
}

export function templatesVersion(language: MeasurementLanguage): string {
  return templatesFor(language).version;
}

export function brandTemplates(language: MeasurementLanguage): Readonly<z.infer<typeof Brand>> {
  return Object.freeze({ ...templatesFor(language).brand });
}

export type PlaceholderShape = "ok" | "place_count" | "wrong_scope" | "unknown_placeholder";

const KNOWN = new Set(["sustantivo", "lugar", "zona", "país"]);

// Local questions name the city exactly once (and the neighborhood at most once); national ones never
// name a city, and the country at most once. Agreement groups ("{un bon|une bonne}") are words,
// not places.
export function placeholderShape(text: string, scope: QuestionScope): PlaceholderShape {
  const names = [...text.matchAll(/\{([^{}]*)\}/g)]
    .map((m) => m[1] ?? "")
    .filter((n) => !isAgreementGroup(n));
  const stray = text.replace(/\{[^{}]*\}/g, "");
  if (stray.includes("{") || stray.includes("}") || names.some((n) => !KNOWN.has(n))) {
    return "unknown_placeholder";
  }
  const count = (name: string) => names.filter((n) => n === name).length;
  if (scope === "local") {
    if (count("país") > 0) return "wrong_scope";
    return count("lugar") === 1 && count("zona") <= 1 ? "ok" : "place_count";
  }
  if (count("lugar") > 0 || count("zona") > 0) return "wrong_scope";
  return count("país") <= 1 ? "ok" : "place_count";
}

export function fallbackTemplates(
  archetype: CategoryArchetype,
  scope: QuestionScope,
  language: MeasurementLanguage,
): FallbackIntent[] {
  const intents = templatesFor(language).archetypes[archetype][scope];
  if (!intents || !ARCHETYPE_SCOPES[archetype].includes(scope)) {
    throw new AppError("internal", {
      detail: `no ${scope} templates for the ${archetype} archetype`,
    });
  }
  return structuredClone(intents);
}

export function canonicalTemplate(
  archetype: CategoryArchetype,
  kind: IntentKind,
  scope: QuestionScope,
  language: MeasurementLanguage,
): string {
  const intent = templatesFor(language).archetypes[archetype][scope]?.find((i) => i.kind === kind);
  if (!intent || !ARCHETYPE_SLATES[archetype].includes(kind)) {
    throw new AppError("internal", { detail: `${kind} is not in the ${archetype}/${scope} slate` });
  }
  return intent.canonical;
}
