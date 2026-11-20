import { z } from "@reranker/schema";
import {
  CategoryArchetype,
  IntentKind,
  ParaphraseFormat,
  QuestionScope,
} from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import evidence from "../data/templates/2026.11.0.de.evidence.json" with { type: "json" };
import data from "../data/templates/2026.11.0.de.json" with { type: "json" };
import { ARCHETYPE_SCOPES, ARCHETYPE_SLATES } from "../src/archetypes";
import { type GuardContext, guardParaphrase } from "../src/generate/guards";
import { AGREEMENT, type GenderedNoun } from "../src/grammar";
import { brandTemplates, fallbackTemplates, placeholderShape } from "../src/templates";
import { instantiate } from "../src/variants";

// German questions sit next to the Spanish file as <version>.de.json, with the same shape and
// placeholder names; <version>.de.evidence.json is their audit trail.
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
  language: z.literal("de"),
  patterns: z.record(
    z.string(),
    z.object({
      support: z.enum(["observed", "adapted", "unsupported"]),
      evidence: z.array(
        z.object({ source: z.string(), market: z.literal("de"), query: z.string().min(1) }),
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
    { archetype, scope, kind: i.kind, text: i.canonical },
    ...i.paraphrases.map((p) => ({ archetype, scope, kind: i.kind, text: p.text })),
  ]);

const allTexts = () => entries.flatMap(({ archetype, scope }) => textsOf(archetype, scope));
// A web-only store's noun is what it sells, often plural or uncountable, so its texts never agree.
const agreeing = () => allTexts().filter((t) => t.archetype !== "online_national");

const groupsOf = (text: string) => [...text.matchAll(AGREEMENT)].map((m) => m[1] ?? "");

// Every masculine|feminine|neuter triple the templates may use, by case. The forms follow the
// standard declension of the definite and indefinite article and of adjectives after each
// (weak after der/die/das, mixed after ein/eine/ein, strong with no article).
const DECLENSION: Record<string, readonly string[]> = {
  nominative: [
    "der|die|das",
    "Welcher|Welche|Welches",
    "der beste|die beste|das beste",
    "der größte|die größte|das größte",
    "der günstigste|die günstigste|das günstigste",
    "ein|eine|ein",
    "Ein guter|Eine gute|Ein gutes",
    "ein guter|eine gute|ein gutes",
    "bester|beste|bestes",
    "Bester|Beste|Bestes",
    "seriöser|seriöse|seriöses",
    "Seriöser|Seriöse|Seriöses",
    "günstiger|günstige|günstiges",
    "Günstiger|Günstige|Günstiges",
    "spezialisierter|spezialisierte|spezialisiertes",
    "veganer|vegane|veganes",
    "hundefreundlicher|hundefreundliche|hundefreundliches",
  ],
  accusative: [
    "Welchen|Welche|Welches",
    "einen|eine|ein",
    "einen guten|eine gute|ein gutes",
    "einen seriösen|eine seriöse|ein seriöses",
    "einen günstigen|eine günstige|ein günstiges",
    "einen spezialisierten|eine spezialisierte|ein spezialisiertes",
    "einen veganen|eine vegane|ein veganes",
    "den besten|die beste|das beste",
  ],
  dative: ["dem|der|dem", "beim|bei der|beim"],
};
const VALID = new Set(Object.values(DECLENSION).flat());

const NOUNS: readonly GenderedNoun[] = [
  { text: "Zahnarzt", gender: "m" },
  { text: "Autowerkstatt", gender: "f" },
  { text: "Hotel", gender: "n" },
];

const ctx = (noun: GenderedNoun | string) => ({
  place: "Berlin",
  zone: "Kreuzberg",
  country: "Deutschland",
  noun,
  language: "de" as const,
});

describe("German fallback templates", () => {
  test.each(entries)(
    "$archetype/$scope covers its slate and passes the guards",
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

  test("only the scopes each archetype is asked in", () => {
    for (const a of CategoryArchetype.options) {
      expect(Object.keys(TEMPLATES.archetypes[a]).sort()).toEqual([...ARCHETYPE_SCOPES[a]].sort());
    }
  });

  test("the loader serves the German set", () => {
    expect(fallbackTemplates("health", "local", "de")).toEqual(intentsOf("health", "local"));
    expect(brandTemplates("de")).toEqual(TEMPLATES.brand);
  });
});

describe("German grammar", () => {
  // "einen guten Zahnarzt", "eine gute Autowerkstatt", "ein gutes Hotel": every word that agrees
  // with the noun is a group of three forms of one case.
  test("every group is a masculine, feminine and neuter triple of one case", () => {
    for (const { text } of allTexts()) {
      for (const group of groupsOf(text)) expect(VALID, `${group} in ${text}`).toContain(group);
    }
  });

  test("no article or declined adjective touches the noun outside a group", () => {
    for (const { text } of agreeing()) {
      const before = text.split("{sustantivo}")[0] ?? "";
      const stripped = before.replace(AGREEMENT, "").trimEnd();
      // The noun opens the text, follows a group, or ends a hyphenated compound ("Online-").
      const ok = before.trim() === "" || stripped !== before.trimEnd() || before.endsWith("-");
      expect(ok, text).toBe(true);
    }
  });

  test("the noun is never plural or inflected", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(/\{sustantivo\}(s|e|en|n|es)\b/);
    }
  });

  test("a web-only store's texts never agree with what it sells", () => {
    for (const { archetype, text } of allTexts()) {
      if (archetype === "online_national") expect(groupsOf(text), text).toEqual([]);
    }
  });

  test("every text reads right for a masculine, a feminine and a neuter noun", () => {
    for (const { archetype, text } of allTexts()) {
      const nouns = archetype === "online_national" ? ["Sneaker"] : NOUNS;
      for (const noun of nouns) {
        const filled = instantiate(text, ctx(noun));
        expect(filled, text).not.toMatch(/[{}|]/);
        expect(filled, text).not.toMatch(/\s{2,}|\s[,?]/);
      }
    }
  });

  test("the forms follow the noun's gender", () => {
    const canonical = intentsOf("health", "local")[0]?.canonical ?? "";
    expect(NOUNS.map((n) => instantiate(canonical, ctx(n)))).toEqual([
      "Kannst du mir einen guten Zahnarzt in Berlin empfehlen?",
      "Kannst du mir eine gute Autowerkstatt in Berlin empfehlen?",
      "Kannst du mir ein gutes Hotel in Berlin empfehlen?",
    ]);
    const ranking = intentsOf("food", "local").find((i) => i.kind === "ranking")?.canonical ?? "";
    expect(instantiate(ranking, ctx({ text: "Bäckerei", gender: "f" }))).toBe(
      "Welche ist die beste Bäckerei in Berlin?",
    );
  });

  // "in der Schweiz", "in den USA": the country only goes where no preposition needs an article.
  test("the country never follows a preposition", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(/\b(in|nach|aus|für|von|im|ins)\s+\{país\}/i);
    }
  });

  test("du throughout, never Sie", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(/\b(Sie|Ihnen|Ihr|Ihre|empfehlen Sie|können Sie)\b/);
    }
  });

  test("standard German spelling: umlauts and ß, never their ASCII stand-ins", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(/\b(gross|groesste|guenstig|naehe|fuer|moechte|ueber)/i);
    }
  });

  test("3 to 40 words, no personal data", () => {
    for (const { text } of allTexts()) {
      const words = text.split(/\s+/).filter(Boolean).length;
      expect(words, text).toBeGreaterThanOrEqual(3);
      expect(words, text).toBeLessThanOrEqual(40);
      expect(text).not.toMatch(/\d{7,}|@/);
    }
  });

  test("every template passes the guards of its own intent", () => {
    const rejected: string[] = [];
    for (const { archetype, scope, kind, text } of allTexts()) {
      const guard: GuardContext = {
        scope,
        kind,
        language: "de",
        noun: archetype === "online_national" ? "Sneaker" : "Zahnarzt",
        synonyms: [],
        countryName: "Deutschland",
        otherPlaceNames: new Set(["Hamburg", "Köln"]),
        blockedNames: new Set(),
      };
      const result = guardParaphrase(
        { text, format: "open_question", generator: "template" },
        guard,
      );
      if (!result.ok) rejected.push(`${archetype}/${kind} ${result.guard}: ${text}`);
    }
    expect(rejected).toEqual([]);
  });
});

describe("German evidence", () => {
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
      if (p.support === "adapted") expect(p.note, key).toBeTruthy();
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
