import { z } from "@reranker/schema";
import {
  CategoryArchetype,
  type QuestionScope,
  type SeedCategoryKey,
} from "@reranker/schema/measurement";
import data from "../data/places-commercial-types.json" with { type: "json" };
import { registerFor } from "./archetypes";

const PlacesTypes = z.object({
  source: z.url(),
  retrievedAt: z.iso.date(),
  types: z.array(
    z.object({
      type: z.string().regex(/^[a-z]+(?:_[a-z]+)*$/),
      group: z.string().min(1),
      label: z.string().min(1),
      // Null for Table A places that are not businesses (parks, churches, transit, government).
      archetype: CategoryArchetype.nullable(),
      commercial: z.boolean(),
    }),
  ),
});

const byType = new Map(PlacesTypes.parse(data).types.map((t) => [t.type, t]));

export function placesTypeArchetype(type: string): CategoryArchetype | null {
  return byType.get(type)?.archetype ?? null;
}

export function placesTypeLabel(type: string): string | null {
  return byType.get(type)?.label ?? null;
}

const restaurantTypes = [...byType.keys()].filter(
  (t) =>
    t === "restaurant" ||
    t.endsWith("_restaurant") ||
    ["bistro", "diner", "steak_house"].includes(t),
);

export type CategoryNames = { noun: string | null; synonyms: string[] };

export type SeedCategory = {
  key: SeedCategoryKey;
  labelKey: string;
  placesTypes: string[];
  /** What fills {sustantivo}; null when the inferred category names it (a web-only store's product). */
  noun: string | null;
  /** Other names the paraphrase guard accepts for the same business. */
  synonyms: string[];
  /**
   * The noun and synonyms in other languages, picked from that language's search data rather than
   * translated: English searches name the dentist, not the clinic.
   */
  languages: Readonly<{ en: Readonly<CategoryNames> }>;
  archetype: CategoryArchetype;
  defaultScope: QuestionScope;
  register: "tu" | "usted";
};

function seed(
  key: SeedCategoryKey,
  archetype: CategoryArchetype,
  defaultScope: QuestionScope,
  placesTypes: string[],
  noun: string | null,
  synonyms: string[],
  en: CategoryNames,
): Readonly<SeedCategory> {
  return Object.freeze({
    key,
    labelKey: `catalog.categories.${key}`,
    placesTypes,
    noun,
    synonyms,
    languages: Object.freeze({ en: Object.freeze(en) }),
    archetype,
    defaultScope,
    register: registerFor(archetype),
  });
}

const SEED_CATEGORIES: ReadonlyArray<Readonly<SeedCategory>> = Object.freeze([
  seed(
    "dental_clinic",
    "health",
    "local",
    ["dental_clinic", "dentist"],
    // Customers search "dentista" and "clínica odontológica"; "odontólogo" searches are mostly about
    // the job, and it names a person, so it is only an accepted synonym.
    "clínica odontológica",
    ["dentista", "odontología", "clínica dental", "consultorio odontológico", "odontólogo"],
    // US searches: "dentist" 1M a month, "dental clinic" 135K, "dental office" 90K.
    { noun: "dentist", synonyms: ["dental clinic", "dental office", "family dentist"] },
  ),
  seed(
    "restaurant",
    "food",
    "local",
    restaurantTypes,
    "restaurante",
    ["sitio para comer", "lugar para comer", "dónde comer"],
    { noun: "restaurant", synonyms: [] },
  ),
  // Motels are left out: in much of Latin America they are love hotels, a different question set.
  seed(
    "hotel",
    "lodging",
    "local",
    [
      "hotel",
      "resort_hotel",
      "extended_stay_hotel",
      "bed_and_breakfast",
      "inn",
      "guest_house",
      "lodging",
    ],
    "hotel",
    ["hospedaje", "alojamiento", "dónde quedarse"],
    { noun: "hotel", synonyms: [] },
  ),
  seed(
    "car_repair",
    "home_auto_services",
    "local",
    ["car_repair"],
    "taller mecánico",
    ["taller automotriz", "taller", "mecánico"],
    // AI search asks for a "mechanic" (293K a month) far more than for "auto repair" (40K).
    {
      noun: "mechanic",
      synonyms: ["auto repair shop", "car repair shop", "auto repair", "car repair"],
    },
  ),
  seed(
    "real_estate_agency",
    "real_estate",
    "local",
    ["real_estate_agency"],
    "inmobiliaria",
    ["agencia inmobiliaria", "agente inmobiliario", "finca raíz"],
    // "realtor" leads national volume on realtor.com lookups; within a city AI search asks for an agent.
    { noun: "real estate agent", synonyms: ["realtor", "real estate agency"] },
  ),
  // A web-only store has no Places type; its noun comes from the inferred category.
  seed(
    "online_store",
    "online_national",
    "national",
    [],
    null,
    ["tienda online", "tienda en línea", "tienda virtual", "comprar por internet"],
    { noun: null, synonyms: ["online store", "online shop"] },
  ),
]);

export function seedCategories(): ReadonlyArray<Readonly<SeedCategory>> {
  return SEED_CATEGORIES;
}
