import { z } from "@reranker/schema";
import {
  CategoryArchetype,
  IntentKind,
  ParaphraseFormat,
  QuestionScope,
} from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import evidence from "../data/templates/2026.11.0.it.evidence.json" with { type: "json" };
import data from "../data/templates/2026.11.0.it.json" with { type: "json" };
import { ARCHETYPE_SCOPES, ARCHETYPE_SLATES } from "../src/archetypes";
import { type GuardContext, guardParaphrase } from "../src/generate/guards";
import type { GenderedNoun } from "../src/grammar";
import { fallbackTemplates, placeholderShape } from "../src/templates";
import { instantiate } from "../src/variants";

// Italian questions sit next to the Spanish file as <version>.it.json, with the same shape and
// placeholder names, plus the two brand questions; <version>.it.evidence.json is their audit trail.
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
  language: z.literal("it"),
  patterns: z.record(
    z.string(),
    z.object({
      support: z.enum(["observed", "adapted", "unsupported"]),
      evidence: z.array(
        z.object({ source: z.string(), market: z.literal("it"), query: z.string().min(1) }),
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

const GROUP = /\{([^{}|]+(?:\|[^{}|]+)+)\}/g;
const groupsOf = (text: string) => [...text.matchAll(GROUP)].map((m) => (m[1] ?? "").split("|"));

// One noun per first sound the articles change with: a plain masculine, an "lo" masculine, a
// vowel masculine, a plain feminine and a vowel feminine.
const NOUNS: GenderedNoun[] = [
  { text: "dentista", gender: "m" },
  { text: "studio dentistico", gender: "m" },
  { text: "hotel", gender: "m" },
  { text: "pasticceria", gender: "f" },
  { text: "agenzia immobiliare", gender: "f" },
];

const fill = (text: string, noun: GenderedNoun) =>
  instantiate(text, {
    place: "Milano",
    zone: "Brera",
    country: "Italia",
    noun,
    language: "it",
    business: "Pasticceria Rossi",
  });

describe("Italian fallback templates", () => {
  test.each(entries)(
    "$archetype/$scope covers its slate and passes the shape checks",
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

  test("the loader serves the same file", () => {
    for (const { archetype, scope } of entries) {
      expect(fallbackTemplates(archetype, scope, "it")).toEqual(intentsOf(archetype, scope));
    }
  });

  test("every agreement group gives a masculine and a feminine form", () => {
    for (const { text } of allTexts()) {
      for (const forms of groupsOf(text)) expect(forms, text).toHaveLength(2);
    }
  });

  // "il dentista" but "lo studio", "l'hotel", "la pasticceria", "l'agenzia": the article right
  // before the noun is only ever a group the catalog resolves, never written out.
  test("no article or articulated preposition is written right before the noun", () => {
    const article =
      /(?<![\p{L}{|'])(il|lo|la|i|gli|le|un|uno|una|del|dello|della|dei|degli|delle|nel|nello|nella|al|allo|alla|dal|dallo|dalla|sul|sullo|sulla)\s+\{sustantivo\}|(?<![\p{L}{|'])(l|un|dell|nell|all|dall|sull)'\{sustantivo\}/iu;
    for (const { text } of allTexts()) expect(text, text).not.toMatch(article);
  });

  // "un buon dentista" but "un buono studio", "un bel negozio" but "un bello studio": these
  // shorten by the noun's spelling, so they never stand right before it.
  test("no word that shortens with the noun's first sound stands before it", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(
        /\b(buon|buono|buona|bel|bello|bella|quel|quello|quella|sant|santo|grande|gran|miglior)\s+\{sustantivo\}/i,
      );
    }
  });

  test("the noun is never pluralized", () => {
    for (const { text } of allTexts()) expect(text, text).not.toMatch(/\{sustantivo\}\p{L}/u);
  });

  // The noun can name a place (studio dentistico) or a person (dentista), so it is never a
  // location the question is asked in.
  test("the noun reads right for a place and for a professional", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(/\b(in|nel|nella|presso)\s+(\{[^}]*\}\s+)?\{sustantivo\}/i);
    }
  });

  // "in Italia" but "negli Stati Uniti": the country only goes where no article is needed.
  test("the country never follows a preposition that would need an article", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(/\b(in|a|di|da|per|su|tra|fra)\s+\{país\}/i);
    }
  });

  test("informal tu throughout, never the formal Lei or the plural voi", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(
        /\b(mi consiglia|consigliatemi|mi consigliate|mi dica|potrebbe|Lei)\b/,
      );
    }
  });

  test("every text reads right for every gender and first sound", () => {
    for (const { text } of allTexts()) {
      for (const noun of NOUNS) {
        const out = fill(text, noun);
        expect(out, out).not.toMatch(/[{}]|\s{2}|\s[,?]/);
        expect(out, out).toContain(noun.text);
        // An elided article never leaves a space before the noun, and "lo"/"uno" only stand
        // before the nouns that take them.
        expect(out, out).not.toMatch(/(?:^|\s)(l|un|dell|nell|all|dall|sull)'\s/i);
        if (noun.text !== "studio dentistico") expect(out, out).not.toMatch(/\b(lo|uno) \p{L}/iu);
      }
    }
  });

  test("the articles take the noun's form", () => {
    const at = (text: string) => NOUNS.map((n) => fill(text, n));
    expect(at("Qual è {il|la} {sustantivo} migliore a {lugar}?")).toEqual([
      "Qual è il dentista migliore a Milano?",
      "Qual è lo studio dentistico migliore a Milano?",
      "Qual è l'hotel migliore a Milano?",
      "Qual è la pasticceria migliore a Milano?",
      "Qual è l'agenzia immobiliare migliore a Milano?",
    ]);
    expect(at("Mi consigli {un|una} {sustantivo} a {lugar}?")).toEqual([
      "Mi consigli un dentista a Milano?",
      "Mi consigli uno studio dentistico a Milano?",
      "Mi consigli un hotel a Milano?",
      "Mi consigli una pasticceria a Milano?",
      "Mi consigli un'agenzia immobiliare a Milano?",
    ]);
    expect(at("{sustantivo} {aperto|aperta} oggi {lugar}")[3]).toBe(
      "pasticceria aperta oggi Milano",
    );
  });

  test("3 to 40 words, no personal data", () => {
    for (const { text } of allTexts()) {
      const words = text.split(/\s+/).filter(Boolean).length;
      expect(words, text).toBeGreaterThanOrEqual(3);
      expect(words, text).toBeLessThanOrEqual(40);
      expect(text).not.toMatch(/\d{7,}|@/);
    }
  });

  // Every template passes the paraphrase guards of its own intent in Italian, so qualifiers stay
  // in their intent and no capitalized word reads as a name.
  test("every template passes the Italian guards of its own intent", () => {
    const rejected: string[] = [];
    for (const { archetype, scope, kind, text } of allTexts()) {
      const ctx: GuardContext = {
        scope,
        kind,
        language: "it",
        noun: "pasticceria",
        synonyms: [],
        countryName: "Italia",
        otherPlaceNames: new Set(["Roma", "Torino", "Napoli"]),
        blockedNames: new Set(),
      };
      const r = guardParaphrase({ text, format: "open_question", generator: "template" }, ctx);
      if (!r.ok) rejected.push(`${archetype}/${scope}/${kind} ${r.guard}: ${text}`);
    }
    expect(rejected).toEqual([]);
  });

  test("the canonical opens like the observed query it follows", () => {
    expect(intentsOf("food", "local")[0]?.canonical).toBe(
      "Mi consigli {un|una} {sustantivo} a {lugar}?",
    );
    expect(intentsOf("online_national", "national")[0]?.canonical).toBe(
      "Mi consigli un negozio online di {sustantivo}?",
    );
  });
});

describe("Italian evidence", () => {
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
    expect(fill(TEMPLATES.brand["brand.trust"], NOUNS[0] as GenderedNoun)).toBe(
      "Pasticceria Rossi a Milano è affidabile?",
    );
  });
});
