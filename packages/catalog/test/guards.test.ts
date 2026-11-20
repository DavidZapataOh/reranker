import { CategoryArchetype, type IntentKind } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import { ARCHETYPE_SCOPES } from "../src/archetypes";
import { type GuardContext, guardParaphrase } from "../src/generate/guards";
import { fallbackTemplates } from "../src/templates";

const bakeryDiscovery: GuardContext = {
  scope: "local",
  kind: "discovery",
  language: "es",
  noun: "panadería",
  synonyms: ["pastelería"],
  countryName: "Colombia",
  otherPlaceNames: new Set(["Cali", "Bogotá", "Santa Marta"]),
  blockedNames: new Set(["Pan Pa' Ya"]),
};

function outcome(text: string, ctx: GuardContext = bakeryDiscovery) {
  const result = guardParaphrase({ text, format: "open_question", generator: "openai" }, ctx);
  return result.ok ? "ok" : result.guard;
}

test.each([
  ["¿Qué panadería me recomiendas en {lugar}?", "ok"],
  ["¿Qué panadería me recomiendas en {lugar} o en Cali?", "placeholder"],
  ["¿Qué panadería me recomiendas?", "placeholder"],
  ["¿Qué ferretería me recomiendas en {lugar}?", "category_noun"],
  ["¿Panadería Santa Clara en {lugar} es buena?", "proper_name"],
  ["Panadería barata en {lugar}", "qualifier"],
  ["Pan {lugar}", "length"],
  ["Panadería en {lugar}, llámenme al 3001234567", "personal_data"],
])("%s → %s", (text, expected) => expect(outcome(text)).toBe(expected));

describe("placeholder", () => {
  test("another city is caught in any case and without accents", () => {
    expect(outcome("panaderías en {lugar} y en bogota")).toBe("placeholder");
    expect(outcome("¿Qué panadería hay en {lugar} cerca a santa marta?")).toBe("placeholder");
  });

  test("a word that only contains a city name is not that city", () => {
    expect(outcome("¿Qué panadería me recomiendas en {lugar} para calentar el día?")).toBe("ok");
  });

  test("national accepts {país}, 'todo el país' or no place and rejects a city", () => {
    const national: GuardContext = { ...bakeryDiscovery, scope: "national" };
    expect(outcome("¿Qué panadería hace envíos a todo {país}?", national)).toBe("ok");
    expect(outcome("¿Qué panadería hace envíos a todo el país?", national)).toBe("ok");
    expect(outcome("¿Qué panadería en Colombia hace envíos?", national)).toBe("ok");
    expect(outcome("¿Qué panadería online me recomiendas?", national)).toBe("ok");
    expect(outcome("¿Qué panadería me recomiendas en Cali?", national)).toBe("placeholder");
    expect(outcome("¿Qué panadería me recomiendas en {lugar}?", national)).toBe("placeholder");
  });
});

describe("category noun", () => {
  test("plurals, synonyms, accents and the {sustantivo} placeholder count", () => {
    expect(outcome("¿Qué panaderías me recomiendas en {lugar}?")).toBe("ok");
    expect(outcome("¿Qué pastelería me recomiendas en {lugar}?")).toBe("ok");
    expect(outcome("¿Qué panaderia me recomiendas en {lugar}?")).toBe("ok");
    expect(outcome("¿Qué {sustantivo} me recomiendas en {lugar}?")).toBe("ok");
  });

  test("every word of a multi-word noun must appear, in order", () => {
    const dental = { ...bakeryDiscovery, noun: "clínica odontológica", synonyms: [] };
    expect(outcome("¿Qué clínicas odontológicas hay en {lugar}?", dental)).toBe("ok");
    expect(outcome("¿Qué clínica me recomiendas en {lugar}?", dental)).toBe("category_noun");
  });
});

describe("proper names", () => {
  test("blocked business names are caught in lower case too", () => {
    expect(outcome("¿pan pa ya es buena panadería en {lugar}?")).toBe("proper_name");
  });

  test("capitals that start a sentence, the country or the noun are not names", () => {
    expect(outcome("Busco panadería en {lugar}. Panadería con pan de Colombia, ¿cuál?")).toBe("ok");
    expect(outcome("Voy a {lugar}: ¿Qué panadería me recomiendas?")).toBe("ok");
  });

  test("English keeps I, weekdays and months capitalized", () => {
    const english: GuardContext = {
      ...bakeryDiscovery,
      language: "en",
      noun: "bakery",
      synonyms: [],
    };
    expect(outcome("Which bakery in {lugar} do I go to on Sunday in December?", english)).toBe(
      "ok",
    );
    expect(outcome("Is Sunrise Bakery in {lugar} any good?", english)).toBe("proper_name");
  });
});

describe("qualifiers", () => {
  test("an intent keeps its own qualifier and rejects another one", () => {
    const price = { ...bakeryDiscovery, kind: "price" as const };
    expect(outcome("Panadería barata en {lugar}", price)).toBe("ok");
    expect(outcome("Panadería barata en {lugar} abierta hoy", price)).toBe("qualifier");
  });

  test("a neighborhood placeholder is a zone qualifier", () => {
    expect(outcome("¿Qué panadería me recomiendas en {zona}, {lugar}?")).toBe("qualifier");
    const zone = { ...bakeryDiscovery, kind: "zone" as const };
    expect(outcome("¿Qué panadería me recomiendas en {zona}, {lugar}?", zone)).toBe("ok");
  });

  test("qualifiers follow the measurement language", () => {
    const pt: GuardContext = { ...bakeryDiscovery, language: "pt", noun: "padaria", synonyms: [] };
    expect(outcome("Qual padaria você recomenda em {lugar}?", pt)).toBe("ok");
    expect(outcome("Qual padaria barata você recomenda em {lugar}?", pt)).toBe("qualifier");
    // Agreement groups are read as their first form, so their words are still screened.
    expect(outcome("Você me indica {um bom|uma boa} {sustantivo} em {lugar}?", pt)).toBe("ok");
    expect(outcome("{Um|Uma} {sustantivo} {barato|barata} em {lugar}?", pt)).toBe("qualifier");
    const en: GuardContext = { ...bakeryDiscovery, language: "en", noun: "bakery", synonyms: [] };
    expect(outcome("Which bakery do you recommend in {lugar}?", en)).toBe("ok");
    expect(outcome("Which bakery in {lugar} is open today?", en)).toBe("qualifier");
  });
});

describe("length and personal data", () => {
  test("3 to 40 words", () => {
    expect(outcome("panadería {lugar} centro")).toBe("ok");
    expect(outcome(`panadería en {lugar} ${"para la casa ".repeat(13)}`)).toBe("length");
  });

  test.each([
    "¿Qué panadería en {lugar} me recomiendas? escríbeme a ana@correo.com",
    "Panadería en {lugar}, mi número es 300 123 4567",
    "Panadería en {lugar} para la cédula 1.023.456.789",
  ])("%s", (text) => expect(outcome(text)).toBe("personal_data"));

  test("short numbers are not personal data", () => {
    expect(outcome("Recomiéndame 3 panaderías en {lugar}")).toBe("ok");
  });
});

// The Spanish fallback templates are written per intent, so their own guards must accept every one
// of them; the guards screen Spanish paraphrases.
test("every fallback template passes the guards of its own intent", () => {
  const rejected: string[] = [];
  for (const archetype of CategoryArchetype.options) {
    for (const scope of ARCHETYPE_SCOPES[archetype]) {
      for (const intent of fallbackTemplates(archetype, scope, "es")) {
        const ctx: GuardContext = {
          ...bakeryDiscovery,
          scope,
          kind: intent.kind as IntentKind,
        };
        for (const p of [
          { text: intent.canonical, format: "open_question" as const },
          ...intent.paraphrases,
        ]) {
          const r = guardParaphrase({ ...p, generator: "template" }, ctx);
          if (!r.ok) rejected.push(`${archetype}/${scope}/${intent.kind} ${r.guard}: ${p.text}`);
        }
      }
    }
  }
  expect(rejected).toEqual([]);
});

describe("German proper names", () => {
  const dentist: GuardContext = {
    scope: "local",
    kind: "discovery",
    language: "de",
    noun: "Zahnarzt",
    synonyms: ["Zahnarztpraxis"],
    countryName: "",
    otherPlaceNames: new Set(["Essen"]),
    blockedNames: new Set(),
  };
  const bakery: GuardContext = { ...dentist, noun: "Bäckerei", synonyms: [] };

  test.each([
    ["Bäckerei mit frischem Brot in {lugar}", "ok"],
    ["Welche Bäckerei in {lugar} hat am Sonntag Brötchen und Kuchen?", "ok"],
    // Compounds the lists do not hold whole are known by their head noun.
    ["Gibt es eine Bio-Bäckerei mit Vollkornbrot in {lugar}?", "ok"],
  ])("%s → %s", (text, expected) => expect(outcome(text, bakery)).toBe(expected));

  test.each([
    ["Kannst du mir einen Zahnarzt mit Kinderbehandlungsraum in {lugar} empfehlen?", "ok"],
    ["Zahnarzt bei Müller GmbH in {lugar}", "proper_name"],
    // A city the set does not target, and one that is also a common noun ("Essen") when listed.
    ["Guter Zahnarzt in {lugar} oder in Hamburg?", "proper_name"],
    ["Guter Zahnarzt in {lugar} oder in Essen?", "placeholder"],
    // A word neither list knows is taken for a name.
    ["Ist Zahnarzt Quorvexa in {lugar} gut?", "proper_name"],
  ])("%s → %s", (text, expected) => expect(outcome(text, dentist)).toBe(expected));

  test("a common noun that is also a surname passes alone", () =>
    expect(outcome("Zahnarzt in {lugar} für Müller und Bäcker", dentist)).toBe("ok"));
});

test("a German compound that holds the category noun names the category", () => {
  const dentist: GuardContext = {
    ...bakeryDiscovery,
    language: "de",
    noun: "Zahnarzt",
    synonyms: [],
    countryName: "",
    otherPlaceNames: new Set(),
    blockedNames: new Set(),
  };
  expect(outcome("Welche Zahnarztpraxen in {lugar} nehmen neue Patienten?", dentist)).toBe("ok");
  expect(outcome("Kannst du mir einen Kinderzahnarzt in {lugar} empfehlen?", dentist)).toBe("ok");
});
