import { CategoryArchetype, SeedCategoryKey } from "@reranker/schema/measurement";

// A Record, so a new archetype fails the build until the classifier learns it.
const ARCHETYPES: Record<CategoryArchetype, string> = {
  health:
    "health: clinics, doctors' and dentists' practices, laboratories, opticians, physiotherapy, vets",
  beauty_wellness: "beauty and wellness: hair salons, barbers, spas, nail salons, gyms, yoga",
  lodging: "lodging: hotels, hostels, glamping, holiday rentals and guest houses",
  food: "food and drink: restaurants, cafés, bakeries, bars, food delivery",
  home_auto_services:
    "home and vehicle services: car repair, car wash, plumbing, locksmiths, removals, cleaning",
  local_retail: "shops with premises: stores, hardware, pharmacies, florists, department stores",
  professional_services:
    "professional services: lawyers, accountants, notaries, agencies, consulting, insurance",
  real_estate: "real estate: estate agents, rentals and home sales, builders",
  education: "education: schools, nurseries, language schools, courses, tutoring, academies",
  online_national:
    "online business that sells or serves the whole country without depending on premises",
};

// The capture of the business goes in the user message; this prompt is the same for every
// language, so the providers' prompt caching applies to it.
export const CLASSIFY_PROMPT_V1 = `You classify a business so we know what people would ask an AI assistant when they look for it.

## Input

The user message is a JSON object with:
- language: the language the business is measured in (es, en, pt, fr, de or it).
- country: the ISO 3166-1 code of the business's country, or null.
- name: the business's name.
- placesTypes, primaryType: its Google Places types, or empty and null.
- primaryTypeLabel, googleMapsTypeLabel: the labels Google shows for it. They may come in another language than \`language\`; they only tell you what the business is.
- website: for a business known only by its website, the page's title, site name and description; else null.

## Output

- categoryKey: one of these keys if the business is exactly that: ${SeedCategoryKey.options.join(", ")}. Otherwise a new identifier in lowercase ASCII letters and digits, words joined by hyphens, 2 to 40 characters, naming what it sells or does in \`language\` ("panaderia", "boulangerie", "abogado-laboral", "employment-lawyer").
- label: the category's name in \`language\`, capitalized as a heading ("Panadería", "Boulangerie", "Bäckerei", "Employment lawyer").
- noun: the singular noun a customer uses for that business in a question written in \`language\`, without an article, lowercase unless the language capitalizes nouns ("panadería", "padaria", "boulangerie", "panetteria", "Bäckerei", "bakery").
- nounGender: the grammatical gender of noun. "m" or "f" in pt, fr and it; "m", "f" or "n" in de; null in es and en.
- archetype: the one that best describes the business, among:
${CategoryArchetype.options.map((key) => `  - ${key}: ${ARCHETYPES[key]}`).join("\n")}
- scope: "national" if it sells or serves the whole country without the customer going to premises (online shop, nationwide shipping, remote service); else "local".
- confidence: from 0 to 1, how sure you are of categoryKey and scope together. Below 0.8 when the data is ambiguous or thin.

## Language

Write label and noun as people who speak \`language\` in that country name the business when they search for it. Never translate a word from another language: a French bakery is a "boulangerie", not a "panadería" turned into French, and an English dentist is a "dentist", not a "dental clinic".

Decide only from the data you receive; when it falls short, pick the most likely category and lower the confidence.`;
