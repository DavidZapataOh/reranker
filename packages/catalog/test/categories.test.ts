import { CategoryArchetype, SeedCategoryKey } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import placesTypes from "../data/places-commercial-types.json" with { type: "json" };
import { ARCHETYPE_SCOPES, ARCHETYPE_SLATES, registerFor } from "../src/archetypes";
import { placesTypeArchetype, placesTypeLabel, seedCategories } from "../src/categories";
import { nounText } from "../src/grammar";

describe("seed categories", () => {
  test("six seed categories with their Places types and scope", () => {
    expect(seedCategories().map((c) => c.key)).toEqual(SeedCategoryKey.options);
    expect(seedCategories().find((c) => c.key === "online_store")).toMatchObject({
      defaultScope: "national",
      archetype: "online_national",
      placesTypes: [],
    });
    expect(seedCategories().find((c) => c.key === "dental_clinic")?.placesTypes).toEqual(
      expect.arrayContaining(["dental_clinic", "dentist"]),
    );
  });

  test("restaurant covers every restaurant subtype and hotel its lodging subtypes", () => {
    const restaurant = seedCategories().find((c) => c.key === "restaurant")?.placesTypes ?? [];
    expect(restaurant).toEqual(
      expect.arrayContaining(["restaurant", "italian_restaurant", "colombian_restaurant"]),
    );
    expect(restaurant).not.toContain("bakery");
    const hotel = seedCategories().find((c) => c.key === "hotel")?.placesTypes ?? [];
    expect(hotel).toEqual(expect.arrayContaining(["hotel", "bed_and_breakfast", "resort_hotel"]));
    // A motel is a love hotel in much of Latin America: a different question set.
    expect(hotel).not.toContain("motel");
  });

  test("every seed Places type is a commercial Table A type of the same archetype", () => {
    for (const c of seedCategories()) {
      for (const type of c.placesTypes) expect(placesTypeArchetype(type)).toBe(c.archetype);
    }
  });

  test("no Places type belongs to two seed categories", () => {
    const all = seedCategories().flatMap((c) => c.placesTypes);
    expect(new Set(all).size).toBe(all.length);
  });

  test("register follows the archetype and synonyms are lowercase", () => {
    for (const c of seedCategories()) {
      expect(c.register).toBe(registerFor(c.archetype));
      expect(c.labelKey).toBe(`catalog.categories.${c.key}`);
      expect(c.synonyms.length).toBeGreaterThan(0);
      for (const s of c.synonyms) expect(s).toBe(s.toLowerCase());
      expect(c.synonyms).not.toContain(c.noun);
    }
  });

  test("English nouns follow English searches, not a translation", () => {
    const en = (key: string) => seedCategories().find((c) => c.key === key)?.languages.en;
    expect(en("dental_clinic")?.noun).toBe("dentist");
    expect(en("car_repair")?.noun).toBe("mechanic");
    expect(en("real_estate_agency")?.noun).toBe("real estate agent");
    expect(en("real_estate_agency")?.synonyms).toContain("realtor");
    expect(en("online_store")?.noun).toBeNull();
    for (const c of seedCategories()) {
      const { noun, synonyms } = c.languages.en;
      // English templates never agree with the noun, so it stays a bare string.
      expect(noun === null || typeof noun === "string").toBe(true);
      expect(noun).toBe(typeof noun === "string" ? noun.toLowerCase() : null);
      for (const s of synonyms) expect(s).toBe(s.toLowerCase());
      expect(synonyms).not.toContain(noun);
    }
  });

  test("German nouns follow German searches, capitalized and with their gender", () => {
    const de = (key: string) => seedCategories().find((c) => c.key === key)?.languages.de;
    expect(de("dental_clinic")?.noun).toEqual({ text: "Zahnarzt", gender: "m" });
    expect(de("car_repair")?.noun).toEqual({ text: "Autowerkstatt", gender: "f" });
    expect(de("hotel")?.noun).toEqual({ text: "Hotel", gender: "n" });
    expect(de("online_store")?.noun).toBeNull();
    for (const c of seedCategories()) {
      const { noun, synonyms } = c.languages.de;
      if (noun !== null) {
        expect(noun.text).toMatch(/^\p{Lu}/u);
        expect(synonyms).not.toContain(noun.text);
      }
      // A noun is capitalized; a search phrase ("essen gehen") is written as people type it.
      for (const s of synonyms) if (!s.includes(" ")) expect(s).toMatch(/^\p{Lu}/u);
    }
  });

  test("Italian nouns follow Italian searches and carry their gender", () => {
    const it = (key: string) => seedCategories().find((c) => c.key === key)?.languages.it;
    expect(it("dental_clinic")?.noun).toEqual({ text: "dentista", gender: "m" });
    expect(it("car_repair")?.noun).toEqual({ text: "meccanico", gender: "m" });
    expect(it("real_estate_agency")?.noun).toEqual({ text: "agenzia immobiliare", gender: "f" });
    expect(it("online_store")?.noun).toBeNull();
    for (const c of seedCategories()) {
      const names = c.languages.it;
      expect(names, c.key).toBeDefined();
      const noun = names?.noun ?? null;
      if (noun !== null) {
        expect(typeof noun).toBe("object");
        expect(nounText(noun)).toBe(nounText(noun).toLowerCase());
      }
      for (const s of names?.synonyms ?? []) expect(s).toBe(s.toLowerCase());
    }
  });

  test("the noun is the business people search for, not the professional", () => {
    const dental = seedCategories().find((c) => c.key === "dental_clinic");
    expect(dental?.noun).toBe("clínica odontológica");
    expect(dental?.synonyms).toEqual(expect.arrayContaining(["dentista", "odontología"]));
    expect(seedCategories().find((c) => c.key === "online_store")?.noun).toBeNull();
    for (const c of seedCategories().filter((s) => s.key !== "online_store")) {
      expect(c.noun).toBe(c.noun?.toLowerCase());
    }
  });
});

describe("archetypes", () => {
  test("every archetype has a slate of six distinct kinds without brand", () => {
    for (const slate of Object.values(ARCHETYPE_SLATES)) {
      expect(new Set(slate).size).toBe(6);
      expect(slate).not.toContain("brand");
      expect(slate[0]).toBe("discovery");
    }
  });

  test("slates from the spec", () => {
    expect(ARCHETYPE_SLATES.food).toEqual([
      "discovery",
      "specialty",
      "zone",
      "price",
      "trust",
      "ranking",
    ]);
    expect(ARCHETYPE_SLATES.online_national).toEqual([
      "discovery",
      "specialty",
      "price",
      "trust",
      "urgency",
      "ranking",
    ]);
  });

  test("an archetype asked nationally has no zone intent", () => {
    for (const a of CategoryArchetype.options) {
      if (ARCHETYPE_SCOPES[a].includes("national"))
        expect(ARCHETYPE_SLATES[a]).not.toContain("zone");
    }
  });

  test("every archetype is asked in tú", () => {
    for (const a of CategoryArchetype.options) expect(registerFor(a)).toBe("tu");
  });
});

describe("Places types", () => {
  test("Places types map to archetypes", () => {
    expect(placesTypeArchetype("bakery")).toBe("food");
    expect(placesTypeArchetype("dentist")).toBe("health");
    expect(placesTypeArchetype("route")).toBeNull(); // Table B
    expect(placesTypeArchetype("church")).toBeNull(); // Table A, not a business we measure
  });

  test("labels are es-CO and exist for every Table A type", () => {
    expect(placesTypeLabel("bakery")).toBe("Panadería");
    expect(placesTypeLabel("italian_restaurant")).toBe("Restaurante italiano");
    expect(placesTypeLabel("church")).toBe("Iglesia");
    expect(placesTypeLabel("route")).toBeNull();
  });

  test("the file is a clean copy of Table A", () => {
    const types = placesTypes.types.map((t) => t.type);
    expect(new Set(types).size).toBe(types.length);
    for (const t of placesTypes.types) {
      expect(t.type).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
      expect(t.label).toMatch(/^\p{Lu}/u);
      expect(t.archetype === null).toBe(!t.commercial);
      if (t.archetype !== null) expect(CategoryArchetype.options).toContain(t.archetype);
    }
    // online_national has no Places type: a web-only store has no storefront to list.
    expect(placesTypes.types.some((t) => t.archetype === "online_national")).toBe(false);
  });
});
