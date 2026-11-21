import { z } from "@reranker/schema";
import {
  CategoryArchetype,
  type MeasurementLanguage,
  type QuestionScope,
  type SeedCategoryKey,
} from "@reranker/schema/measurement";
import data from "../data/places-commercial-types.json" with { type: "json" };
import { registerFor } from "./archetypes";
import { type GenderedNoun, type Noun, nounText } from "./grammar";

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
  it: CategoryNames<GenderedNoun>;
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
      it: Object.freeze(languages.it),
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
    // Colombia: "consultorio dental" 720 a month, a quarter of "clínica odontológica" (2.9K).
    [
      "dentista",
      "odontología",
      "clínica dental",
      "consultorio odontológico",
      "consultorio dental",
      "odontólogo",
    ],
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
      // Italian searches: "dentista" 90.5K a month and 9.2K AI searches; "studio dentistico" only
      // shows up with "vicino a me" (4.4K) and "clinica dentale" with a clinic's name.
      it: {
        noun: { text: "dentista", gender: "m" },
        synonyms: ["studio dentistico", "clinica dentale", "odontoiatra"],
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
      // AI search asks "where to eat" 751K times a month, an eighth of "restaurant" (5.9M).
      en: { noun: "restaurant", synonyms: ["where to eat"] },
      // Brazil: "restaurante" 9.1M a month; AI search asks "onde comer" 15K times (18% of 84K).
      pt: { noun: { text: "restaurante", gender: "m" }, synonyms: ["onde comer"] },
      // AI search in France asks "où manger" 303K times a month, half as often as "restaurant".
      fr: { noun: { text: "restaurant", gender: "m" }, synonyms: ["où manger"] },
      // 321K AI searches a month in Germany; "essen gehen" 108K.
      de: { noun: { text: "Restaurant", gender: "n" }, synonyms: ["essen gehen"] },
      // "ristorante": 550K a month, 352K AI searches.
      it: {
        noun: { text: "ristorante", gender: "m" },
        // AI search asks "dove mangiare" 248K times a month.
        synonyms: ["trattoria", "osteria", "pizzeria", "dove mangiare"],
      },
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
      // AI search asks "where to stay" 364K times a month, 14% of "hotel" (2.6M).
      en: { noun: "hotel", synonyms: ["where to stay"] },
      // Brazil: "hotel" 2.2M a month; "pousada" (301K) names the inns the category's types cover.
      pt: { noun: { text: "hotel", gender: "m" }, synonyms: ["pousada"] },
      // The h of "hôtel" is mute: "l'hôtel".
      fr: { noun: { text: "hôtel", gender: "m", elides: true }, synonyms: ["chambre d'hôte"] },
      // "hotel" 514K AI searches a month, "pension" 22K.
      de: { noun: { text: "Hotel", gender: "n" }, synonyms: ["Pension"] },
      // "hotel": 5M a month and 254K AI searches; people say "albergo" far less, B&Bs search apart.
      // AI search asks "dove dormire" 43K times a month (17%).
      it: {
        noun: { text: "hotel", gender: "m" },
        synonyms: ["albergo", "bed and breakfast", "dove dormire"],
      },
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
        // "garagiste" 301K a month, as many as "garage".
        synonyms: ["garage automobile", "garage auto", "mécanicien", "garagiste"],
      },
      // "autowerkstatt" 60.5K a month (5.2K AI), "kfz werkstatt" 40.5K (3.7K AI).
      de: {
        noun: { text: "Autowerkstatt", gender: "f" },
        // "autoreparatur" 873 AI searches a month, 17% of "autowerkstatt".
        synonyms: ["Kfz-Werkstatt", "Werkstatt", "Autoreparatur"],
      },
      // "meccanico": 90.5K a month and 7.3K AI searches, against 18.1K and 595 for "officina meccanica".
      it: {
        noun: { text: "meccanico", gender: "m" },
        synonyms: ["officina meccanica", "officina", "autofficina"],
      },
    },
  ),
  seed(
    "real_estate_agency",
    "real_estate",
    "local",
    ["real_estate_agency"],
    "inmobiliaria",
    // Colombia: "bienes raíces" 1.9K a month, a tenth of "inmobiliaria" (18.1K).
    ["agencia inmobiliaria", "agente inmobiliario", "finca raíz", "bienes raíces"],
    {
      // "realtor" leads national volume on realtor.com lookups; within a city AI search asks for an agent.
      // AI search asks for an "estate agent" 72K times a month, as often as a "real estate agent".
      en: {
        noun: "real estate agent",
        synonyms: ["realtor", "real estate agency", "estate agent"],
      },
      // Brazil: "imobiliária" 246K a month (10.4K AI, 175 in São Paulo), "corretor de imóveis" 50K (7).
      pt: { noun: { text: "imobiliária", gender: "f" }, synonyms: ["corretor de imóveis"] },
      // France: "agence immobilière" 201K a month, "agent immobilier" 27.1K.
      // "agence immo" 165K a month, the short form people type.
      fr: {
        noun: { text: "agence immobilière", gender: "f" },
        synonyms: ["agent immobilier", "agence immo"],
      },
      // "immobilienmakler" 40.5K a month; "makler" (14.8K) is mostly "ohne makler" and insurance.
      de: { noun: { text: "Immobilienmakler", gender: "m" }, synonyms: ["Makler"] },
      // "agenzia immobiliare": 74K a month and 11K AI searches, against 5.4K and 1.7K for the agent.
      it: {
        noun: { text: "agenzia immobiliare", gender: "f" },
        synonyms: ["agente immobiliare", "immobiliare"],
      },
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
      it: { noun: null, synonyms: ["negozio online", "shop online", "sito"] },
    },
  ),
]);

export function seedCategories(): ReadonlyArray<Readonly<SeedCategory>> {
  return SEED_CATEGORIES;
}

/** The words people search a category by in each language: its noun first, then its synonyms. */
export function categoryTerms(
  category: Readonly<SeedCategory>,
): Partial<Record<MeasurementLanguage, string[]>> {
  const terms = (names: { noun: Noun | null; synonyms: readonly string[] }) => [
    ...(names.noun === null ? [] : [nounText(names.noun)]),
    ...names.synonyms,
  ];
  return {
    es: terms(category),
    ...Object.fromEntries(
      Object.entries(category.languages).map(([language, names]) => [language, terms(names)]),
    ),
  };
}
