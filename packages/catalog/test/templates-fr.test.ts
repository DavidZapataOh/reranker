import { z } from "@reranker/schema";
import {
  CategoryArchetype,
  IntentKind,
  ParaphraseFormat,
  QuestionScope,
} from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import evidence from "../data/templates/2026.11.0.fr.evidence.json" with { type: "json" };
import data from "../data/templates/2026.11.0.fr.json" with { type: "json" };
import { ARCHETYPE_SCOPES, ARCHETYPE_SLATES } from "../src/archetypes";
import { seedCategories } from "../src/categories";
import { type GuardContext, guardParaphrase } from "../src/generate/guards";
import type { GenderedNoun, Noun } from "../src/grammar";
import { brandTemplates, fallbackTemplates, placeholderShape } from "../src/templates";
import { instantiate } from "../src/variants";

// French questions sit next to the Spanish file as <version>.fr.json, with the same shape and
// placeholder names; words that agree with the noun are groups, masculine first.
const Templates = z.object({
  version: z.literal("2026.11.0"),
  archetypes: z.record(
    CategoryArchetype,
    z.partialRecord(
      QuestionScope,
      z
        .array(
          z.object({
            kind: IntentKind,
            slug: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
            canonical: z.string().min(1),
            paraphrases: z
              .array(z.object({ text: z.string().min(1), format: ParaphraseFormat }))
              .min(8),
          }),
        )
        .length(6),
    ),
  ),
  brand: z.object({ "brand.trust": z.string(), "brand.opinion": z.string() }).strict(),
});

const TEMPLATES = Templates.parse(data);

const Evidence = z.object({
  version: z.literal(TEMPLATES.version),
  language: z.literal("fr"),
  patterns: z.record(
    z.string(),
    z.object({
      support: z.enum(["observed", "adapted", "unsupported"]),
      evidence: z.array(
        z.object({ source: z.string(), market: z.literal("fr"), query: z.string().min(1) }),
      ),
      note: z.string().optional(),
    }),
  ),
  templates: z.record(z.string(), z.array(z.array(z.string()).min(1))),
  brand: z.record(z.string(), z.array(z.string()).min(1)),
});

const EVIDENCE = Evidence.parse(evidence);

const entries = CategoryArchetype.options.flatMap((archetype) =>
  ARCHETYPE_SCOPES[archetype].map((scope) => ({ archetype, scope })),
);

const intentsOf = (archetype: CategoryArchetype, scope: QuestionScope) =>
  TEMPLATES.archetypes[archetype][scope] ?? [];

const textsOf = (archetype: CategoryArchetype, scope: QuestionScope) =>
  intentsOf(archetype, scope).flatMap((i) => [
    { archetype, scope, kind: i.kind, text: i.canonical, format: "open_question" as const },
    ...i.paraphrases.map((p) => ({ archetype, scope, kind: i.kind, ...p })),
  ]);

const allTexts = () => entries.flatMap(({ archetype, scope }) => textsOf(archetype, scope));

// A web-only store's noun is what it sells, a bare word in any number; every other archetype names
// a business with a gender.
const isProductNoun = (archetype: CategoryArchetype) => archetype === "online_national";

const NOUNS: GenderedNoun[] = [
  { text: "dentiste", gender: "m" },
  { text: "boulangerie", gender: "f" },
  { text: "hôtel", gender: "m", elides: true },
  { text: "agence immobilière", gender: "f" },
];
const PRODUCTS = ["vêtements", "accessoires", "café"];

const fill = (text: string, noun: Noun) =>
  instantiate(text, {
    place: "Lyon",
    zone: "Croix-Rousse",
    country: "France",
    noun,
    language: "fr",
  });

describe("French fallback templates", () => {
  test.each(entries)(
    "$archetype/$scope covers its slate and the formats",
    ({ archetype, scope }) => {
      const t = intentsOf(archetype, scope);
      expect(t.map((i) => i.kind)).toEqual([...ARCHETYPE_SLATES[archetype]]);
      expect(new Set(t.map((i) => i.slug)).size).toBe(t.length);
      for (const i of t) {
        for (const f of ParaphraseFormat.options) {
          expect(i.paraphrases.filter((p) => p.format === f).length).toBeGreaterThanOrEqual(2);
        }
        const texts = [i.canonical, ...i.paraphrases.map((p) => p.text)];
        expect(new Set(texts).size).toBe(texts.length);
        for (const text of texts) {
          expect(placeholderShape(text, scope), text).toBe("ok");
          expect(text).toContain("{sustantivo}");
          expect(text.includes("{zona}")).toBe(i.kind === "zone");
        }
      }
    },
  );

  test("the loader serves the same file", () => {
    for (const { archetype, scope } of entries) {
      expect(fallbackTemplates(archetype, scope, "fr")).toEqual(intentsOf(archetype, scope));
    }
    expect(brandTemplates("fr")).toEqual(TEMPLATES.brand);
  });

  test("every agreement group gives a masculine and a feminine form", () => {
    for (const { text } of allTexts()) {
      for (const [, group] of text.matchAll(/\{([^{}]*\|[^{}]*)\}/g)) {
        expect(group?.split("|"), text).toHaveLength(2);
      }
    }
  });

  // "le dentiste" but "la boulangerie" and "l'hôtel": an article, a demonstrative or an adjective
  // that changes form never sits bare before the noun. The engine elides only le, la, de, du, au
  // and ce, so those reach the noun as a group or a literal "de".
  test("the noun never follows a word whose form the engine does not choose", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(
        /(^|[\s'])(l'|d'|un|une|des|les|aux|cet|cette|beau|bel|belle|nouveau|nouvel|vieux|vieil|mon|ma|ton|ta|son|sa)\s*\{sustantivo\}/i,
      );
      expect(text, text).not.toMatch(/(^|\s)(le|la|du|au|ce)\s+\{sustantivo\}/i);
    }
  });

  test("the noun is never pluralized", () => {
    for (const { text } of allTexts()) expect(text, text).not.toMatch(/\{sustantivo\}[sx]\b/);
  });

  test("a web-only store's product never meets a word that agrees with it", () => {
    for (const { archetype, text } of allTexts()) {
      if (isProductNoun(archetype)) expect(text, text).not.toMatch(/\|/);
    }
  });

  test.each(entries)("$archetype/$scope reads right for every noun", ({ archetype, scope }) => {
    const nouns: Noun[] = isProductNoun(archetype) ? PRODUCTS : NOUNS;
    for (const { text } of textsOf(archetype, scope)) {
      for (const noun of nouns) {
        const out = fill(text, noun);
        expect(out, out).not.toMatch(/[{}|]|\s{2}|^\s|\s$/);
        // Elision: no le, la, de, que or ce left before a vowel or a mute h.
        expect(out, out).not.toMatch(/(^|\s)(le|la|de|que|ce|du|au)\s+(h?[aeiouyàâéèêëîïôûœ])/i);
      }
    }
  });

  test("the article agrees and elides", () => {
    const ranking = intentsOf("food", "local").find((i) => i.kind === "ranking");
    const lowest = ranking?.paraphrases.find((p) => p.text.includes("mieux not"))?.text ?? "";
    expect(fill(lowest, NOUNS[0] as Noun)).toBe("Quel est le dentiste le mieux noté à Lyon ?");
    expect(fill(lowest, NOUNS[1] as Noun)).toBe(
      "Quelle est la boulangerie la mieux notée à Lyon ?",
    );
    expect(fill(lowest, NOUNS[2] as Noun)).toBe("Quel est l'hôtel le mieux noté à Lyon ?");
    const shop = intentsOf("online_national", "national")[0]?.paraphrases[0]?.text ?? "";
    expect(fill(shop, "accessoires")).toBe(
      "Tu peux me conseiller une bonne boutique en ligne d'accessoires ?",
    );
  });

  test("standard French typography: a space before ? ! : ; and none before , .", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(/[^\s][?!:;]/);
      expect(text, text).not.toMatch(/\s[,.]/);
    }
    for (const text of Object.values(TEMPLATES.brand)) expect(text).not.toMatch(/[^\s][?!:;]/);
  });

  // "Paris" but "le Havre" and "la France": a place only follows "à", "dans le quartier" or
  // nothing, never a preposition that would contract with its article.
  test("a place never follows a preposition that would contract with an article", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(/\b(de|du|des|en|au|aux)\s+\{(lugar|zona|país)\}/i);
    }
  });

  test("one register: tu, never vous", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(/\b(vous|votre|vos|pouvez|conseillez|recommandez)\b/i);
    }
  });

  test("3 to 40 words, no personal data", () => {
    for (const { text } of allTexts()) {
      const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}{]/u.test(w)).length;
      expect(words, text).toBeGreaterThanOrEqual(3);
      expect(words, text).toBeLessThanOrEqual(40);
      expect(text).not.toMatch(/\d{7,}|@/);
    }
  });

  test("qualifiers stay in their own intent", () => {
    const qualifiers: Partial<Record<IntentKind, RegExp>> = {
      price: /(pas ch|\bprix\b|tarif|moins ch|gratuit|\bfrais\b|bon marché)/i,
      urgency: /(aujourd|urgence|de garde|\bouvert|24h|maintenant|\bvite\b|demain)/i,
      zone: /(quartier|\bprès\b|proximité|autour de|\{zona\})/i,
    };
    for (const { kind, text } of allTexts()) {
      for (const [owner, pattern] of Object.entries(qualifiers)) {
        if (owner !== kind) expect(text, `${kind}: ${text}`).not.toMatch(pattern);
      }
    }
  });

  // The French guards screen French paraphrases, so they must accept every reviewed template.
  test("every template passes the French guards of its own intent", () => {
    const rejected: string[] = [];
    for (const { archetype, scope, kind, text, format } of allTexts()) {
      const ctx: GuardContext = {
        scope,
        kind,
        language: "fr",
        noun: "boulangerie",
        synonyms: [],
        countryName: "France",
        otherPlaceNames: new Set(["Marseille", "Bordeaux"]),
        blockedNames: new Set(),
      };
      const r = guardParaphrase({ text, format, generator: "template" }, ctx);
      if (!r.ok) rejected.push(`${archetype}/${scope}/${kind} ${r.guard}: ${text}`);
    }
    expect(rejected).toEqual([]);
  });

  test("the canonical opens like the observed query it follows", () => {
    expect(intentsOf("food", "local")[0]?.canonical).toBe(
      "Tu peux me conseiller {un bon|une bonne} {sustantivo} à {lugar} ?",
    );
    expect(intentsOf("online_national", "national")[0]?.canonical).toBe(
      "Quelle est la meilleure boutique en ligne de {sustantivo} ?",
    );
  });
});

describe("French seed nouns", () => {
  test("follow French searches and carry the gender their words agree with", () => {
    const fr = (key: string) => seedCategories().find((c) => c.key === key)?.languages.fr;
    expect(fr("dental_clinic")?.noun).toEqual({ text: "dentiste", gender: "m" });
    expect(fr("hotel")?.noun).toEqual({ text: "hôtel", gender: "m", elides: true });
    expect(fr("car_repair")?.noun).toEqual({ text: "garage", gender: "m" });
    expect(fr("real_estate_agency")?.noun).toEqual({ text: "agence immobilière", gender: "f" });
    expect(fr("online_store")?.noun).toBeNull();
    for (const c of seedCategories()) {
      const names = c.languages.fr;
      expect(names, c.key).toBeDefined();
      if (names?.noun && typeof names.noun !== "string") {
        expect(names.noun.text).toBe(names.noun.text.toLowerCase());
        expect(names.synonyms).not.toContain(names.noun.text);
      }
    }
  });
});

describe("French evidence", () => {
  test("every text names the observed phrasings it follows", () => {
    const declared = new Set(Object.keys(EVIDENCE.patterns));
    for (const { archetype, scope } of entries) {
      for (const i of intentsOf(archetype, scope)) {
        const keys = EVIDENCE.templates[`${archetype}/${scope}/${i.kind}`];
        expect(keys, `${archetype}/${scope}/${i.kind}`).toHaveLength(1 + i.paraphrases.length);
        for (const k of (keys ?? []).flat()) expect(declared).toContain(k);
      }
    }
    expect(Object.keys(EVIDENCE.templates).length).toBe(
      entries.reduce((n, e) => n + intentsOf(e.archetype, e.scope).length, 0),
    );
  });

  test("a pattern cites collected queries unless it is marked unsupported", () => {
    for (const [key, p] of Object.entries(EVIDENCE.patterns)) {
      expect(p.support === "unsupported" || p.evidence.length > 0, key).toBe(true);
      if (p.support !== "observed") expect(p.note, key).toBeTruthy();
    }
  });

  test("brand questions name the business, never a person, and cite their phrasing", () => {
    expect(Object.keys(EVIDENCE.brand).sort()).toEqual(Object.keys(TEMPLATES.brand).sort());
    for (const [key, text] of Object.entries(TEMPLATES.brand)) {
      expect(text).toContain("{business}");
      expect(text).not.toContain("{sustantivo}");
      for (const k of EVIDENCE.brand[key] ?? []) expect(EVIDENCE.patterns).toHaveProperty(k);
    }
  });
});
