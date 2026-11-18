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

export type SeedCategory = {
  key: SeedCategoryKey;
  labelKey: string;
  placesTypes: string[];
  synonyms: string[];
  archetype: CategoryArchetype;
  defaultScope: QuestionScope;
  register: "tu" | "usted";
};

function seed(
  key: SeedCategoryKey,
  archetype: CategoryArchetype,
  defaultScope: QuestionScope,
  placesTypes: string[],
  synonyms: string[],
): Readonly<SeedCategory> {
  return Object.freeze({
    key,
    labelKey: `catalog.categories.${key}`,
    placesTypes,
    synonyms,
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
    [
      "clínica odontológica",
      "clínica dental",
      "consultorio odontológico",
      "odontólogo",
      "dentista",
    ],
  ),
  seed("restaurant", "food", "local", restaurantTypes, [
    "restaurante",
    "sitio para comer",
    "lugar para comer",
    "dónde comer",
  ]),
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
    ["hotel", "hospedaje", "alojamiento", "dónde quedarse"],
  ),
  seed(
    "car_repair",
    "home_auto_services",
    "local",
    ["car_repair"],
    ["taller mecánico", "taller automotriz", "taller", "mecánico"],
  ),
  seed(
    "real_estate_agency",
    "real_estate",
    "local",
    ["real_estate_agency"],
    ["inmobiliaria", "agencia inmobiliaria", "agente inmobiliario", "finca raíz"],
  ),
  // A web-only store has no Places type; its noun comes from the inferred category.
  seed(
    "online_store",
    "online_national",
    "national",
    [],
    ["tienda online", "tienda en línea", "tienda virtual", "comprar por internet"],
  ),
]);

export function seedCategories(): ReadonlyArray<Readonly<SeedCategory>> {
  return SEED_CATEGORIES;
}
