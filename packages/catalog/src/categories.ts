import { z } from "@reranker/schema";
import {
  CategoryArchetype,
  type QuestionScope,
  type SeedCategoryKey,
} from "@reranker/schema/measurement";
import data from "../data/places-commercial-types.json" with { type: "json" };
import { registerFor } from "./archetypes";
import type { GenderedNoun, Noun } from "./grammar";

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

/** A language's name for a category; gendered languages carry the noun's gender for agreement. */
export type CategoryNames<N extends Noun = string> = { noun: N | null; synonyms: string[] };

/** Each language's names beside the Spanish ones. */
export type SeedLanguages = {
  en: CategoryNames;
  pt: CategoryNames<GenderedNoun>;
  de: CategoryNames<GenderedNoun>;
  fr: CategoryNames<GenderedNoun>;
};

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
  languages: Readonly<{ [L in keyof SeedLanguages]: Readonly<SeedLanguages[L]> }>;
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
  languages: SeedLanguages,
): Readonly<SeedCategory> {
  return Object.freeze({
    key,
    labelKey: `catalog.categories.${key}`,
    placesTypes,
    noun,
    synonyms,
    languages: Object.freeze({
      en: Object.freeze(languages.en),
      pt: Object.freeze(languages.pt),
      de: Object.freeze(languages.de),
      fr: Object.freeze(languages.fr),
    }),
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
    {
      // US searches: "dentist" 1M a month, "dental clinic" 135K, "dental office" 90K.
      en: { noun: "dentist", synonyms: ["dental clinic", "dental office", "family dentist"] },
      // Brazil: "dentista" 246K a month (10.5K AI searches), "consultório odontológico" 33K.
      pt: {
        noun: { text: "dentista", gender: "m" },
        synonyms: ["consultório odontológico", "clínica odontológica"],
      },
      // France: "dentiste" 201K a month, "cabinet dentaire" 40.5K.
      fr: {
        noun: { text: "dentiste", gender: "m" },
        synonyms: ["cabinet dentaire", "centre dentaire", "chirurgien-dentiste"],
      },
      // Germany: "zahnarzt in meiner nähe" 201K a month, "zahnarztpraxis near me" 74K.
      de: {
        noun: { text: "Zahnarzt", gender: "m" },
        synonyms: ["Zahnarztpraxis", "Zahnklinik", "Zahnärzte"],
      },
    },
  ),
  seed(
    "restaurant",
    "food",
    "local",
    restaurantTypes,
    "restaurante",
    ["sitio para comer", "lugar para comer", "dónde comer"],
    {
      en: { noun: "restaurant", synonyms: [] },
      // Brazil: "restaurante" 9.1M a month.
      pt: { noun: { text: "restaurante", gender: "m" }, synonyms: [] },
      fr: { noun: { text: "restaurant", gender: "m" }, synonyms: [] },
      // 321K AI searches a month in Germany.
      de: { noun: { text: "Restaurant", gender: "n" }, synonyms: [] },
    },
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
    {
      en: { noun: "hotel", synonyms: [] },
      // Brazil: "hotel" 2.2M a month; "pousada" (301K) names the inns the category's types cover.
      pt: { noun: { text: "hotel", gender: "m" }, synonyms: ["pousada"] },
      // The h of "hôtel" is mute: "l'hôtel".
      fr: { noun: { text: "hôtel", gender: "m", elides: true }, synonyms: ["chambre d'hôte"] },
      // "hotel" 514K AI searches a month, "pension" 22K.
      de: { noun: { text: "Hotel", gender: "n" }, synonyms: ["Pension"] },
    },
  ),
  seed(
    "car_repair",
    "home_auto_services",
    "local",
    ["car_repair"],
    "taller mecánico",
    ["taller automotriz", "taller", "mecánico"],
    {
      // AI search asks for a "mechanic" (293K a month) far more than for "auto repair" (40K).
      en: {
        noun: "mechanic",
        synonyms: ["auto repair shop", "car repair shop", "auto repair", "car repair"],
      },
      // Brazil: "mecânico" 246K a month (13.8K AI searches), "oficina mecânica" 60K (1.2K AI).
      pt: { noun: { text: "mecânico", gender: "m" }, synonyms: ["oficina mecânica", "oficina"] },
      // France: "garage" 301K a month, "mécanicien" 18.1K.
      fr: {
        noun: { text: "garage", gender: "m" },
        synonyms: ["garage automobile", "garage auto", "mécanicien"],
      },
      // "autowerkstatt" 60.5K a month (5.2K AI), "kfz werkstatt" 40.5K (3.7K AI).
      de: {
        noun: { text: "Autowerkstatt", gender: "f" },
        synonyms: ["Kfz-Werkstatt", "Werkstatt"],
      },
    },
  ),
  seed(
    "real_estate_agency",
    "real_estate",
    "local",
    ["real_estate_agency"],
    "inmobiliaria",
    ["agencia inmobiliaria", "agente inmobiliario", "finca raíz"],
    {
      // "realtor" leads national volume on realtor.com lookups; within a city AI search asks for an agent.
      en: { noun: "real estate agent", synonyms: ["realtor", "real estate agency"] },
      // Brazil: "imobiliária" 246K a month (10.4K AI, 175 in São Paulo), "corretor de imóveis" 50K (7).
      pt: { noun: { text: "imobiliária", gender: "f" }, synonyms: ["corretor de imóveis"] },
      // France: "agence immobilière" 201K a month, "agent immobilier" 27.1K.
      fr: { noun: { text: "agence immobilière", gender: "f" }, synonyms: ["agent immobilier"] },
      // "immobilienmakler" 40.5K a month; "makler" (14.8K) is mostly "ohne makler" and insurance.
      de: { noun: { text: "Immobilienmakler", gender: "m" }, synonyms: ["Makler"] },
    },
  ),
  // A web-only store has no Places type; its noun comes from the inferred category.
  seed(
    "online_store",
    "online_national",
    "national",
    [],
    null,
    ["tienda online", "tienda en línea", "tienda virtual", "comprar por internet"],
    {
      en: { noun: null, synonyms: ["online store", "online shop"] },
      // Brazil: "loja online" 12K a month.
      pt: { noun: null, synonyms: ["loja online", "loja virtual"] },
      fr: { noun: null, synonyms: ["boutique en ligne", "magasin en ligne"] },
      de: { noun: null, synonyms: ["Onlineshop", "Online-Shop"] },
    },
  ),
]);

export function seedCategories(): ReadonlyArray<Readonly<SeedCategory>> {
  return SEED_CATEGORIES;
}
