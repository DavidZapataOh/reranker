import { AppError, z } from "@reranker/schema";
import {
  CategoryArchetype,
  IntentKind,
  ParaphraseFormat,
  QuestionScope,
} from "@reranker/schema/measurement";
import data from "../data/templates/2026.11.0.json" with { type: "json" };
import { ARCHETYPE_SCOPES, ARCHETYPE_SLATES } from "./archetypes";

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

const Templates = z.object({
  version: z.literal("2026.11.0"),
  archetypes: z.record(
    CategoryArchetype,
    z.partialRecord(QuestionScope, z.array(Intent).length(6)),
  ),
});

const TEMPLATES = Templates.parse(data);

export const TEMPLATES_VERSION = TEMPLATES.version;

// Brand questions are measured apart and never enter the score.
export const BRAND_TEMPLATES = Object.freeze({
  "brand.trust": "¿{business} en {lugar} es confiable?",
  "brand.opinion": "¿Qué opinas de {business}?",
});

export type PlaceholderShape = "ok" | "place_count" | "wrong_scope" | "unknown_placeholder";

const KNOWN = new Set(["sustantivo", "lugar", "zona", "país"]);

// Local questions name the city exactly once (and the neighborhood at most once); national ones never
// name a city, and the country at most once.
export function placeholderShape(text: string, scope: QuestionScope): PlaceholderShape {
  const names = [...text.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] ?? "");
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
): FallbackIntent[] {
  const intents = TEMPLATES.archetypes[archetype][scope];
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
): string {
  const intent = TEMPLATES.archetypes[archetype][scope]?.find((i) => i.kind === kind);
  if (!intent || !ARCHETYPE_SLATES[archetype].includes(kind)) {
    throw new AppError("internal", { detail: `${kind} is not in the ${archetype}/${scope} slate` });
  }
  return intent.canonical;
}
