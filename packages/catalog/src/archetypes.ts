import type { CategoryArchetype, IntentKind, QuestionScope } from "@reranker/schema/measurement";

type Slate = readonly [IntentKind, IntentKind, IntentKind, IntentKind, IntentKind, IntentKind];

// Ordered by how much each intent says about the business: the first five complete ones go in the free report.
// Archetypes also asked nationally carry no zone intent, since a neighborhood means nothing country-wide.
export const ARCHETYPE_SLATES: Readonly<Record<CategoryArchetype, Slate>> = {
  health: ["discovery", "specialty", "zone", "urgency", "insurance_or_payment", "trust"],
  beauty_wellness: ["discovery", "specialty", "zone", "price", "trust", "ranking"],
  lodging: ["discovery", "specialty", "zone", "price", "trust", "ranking"],
  food: ["discovery", "specialty", "zone", "price", "trust", "ranking"],
  home_auto_services: ["discovery", "specialty", "zone", "price", "urgency", "trust"],
  local_retail: ["discovery", "specialty", "price", "urgency", "trust", "ranking"],
  professional_services: ["discovery", "specialty", "price", "urgency", "trust", "ranking"],
  real_estate: ["discovery", "specialty", "zone", "price", "trust", "ranking"],
  education: ["discovery", "specialty", "zone", "price", "insurance_or_payment", "trust"],
  online_national: ["discovery", "specialty", "price", "trust", "urgency", "ranking"],
};

// Shops can also sell country-wide; a web-only store has no city to be asked in.
export const ARCHETYPE_SCOPES: Readonly<Record<CategoryArchetype, readonly QuestionScope[]>> = {
  health: ["local"],
  beauty_wellness: ["local"],
  lodging: ["local"],
  food: ["local"],
  home_auto_services: ["local"],
  local_retail: ["local", "national"],
  professional_services: ["local"],
  real_estate: ["local"],
  education: ["local"],
  online_national: ["national"],
};

const USTED: ReadonlySet<CategoryArchetype> = new Set([
  "health",
  "professional_services",
  "education",
]);

export function registerFor(archetype: CategoryArchetype): "tu" | "usted" {
  return USTED.has(archetype) ? "usted" : "tu";
}
