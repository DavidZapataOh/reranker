import { z } from "@reranker/schema";
import {
  CategoryArchetype,
  IntentKind,
  ParaphraseFormat,
  QuestionScope,
} from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import evidence from "../data/templates/2026.11.0.en.evidence.json" with { type: "json" };
import data from "../data/templates/2026.11.0.en.json" with { type: "json" };
import { ARCHETYPE_SCOPES, ARCHETYPE_SLATES } from "../src/archetypes";
import { placeholderShape } from "../src/templates";

// English questions sit next to the Spanish file as <version>.en.json, with the same shape and
// placeholder names, plus the two brand questions; <version>.en.evidence.json is their audit trail.
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
  language: z.literal("en"),
  patterns: z.record(
    z.string(),
    z.object({
      support: z.enum(["observed", "adapted", "unsupported"]),
      evidence: z.array(
        z.object({ source: z.string(), market: z.enum(["us", "gb"]), query: z.string().min(1) }),
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
    { kind: i.kind, text: i.canonical },
    ...i.paraphrases.map((p) => ({ kind: i.kind, text: p.text })),
  ]);

const allTexts = () => entries.flatMap(({ archetype, scope }) => textsOf(archetype, scope));

describe("English fallback templates", () => {
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

  // "a dentist" but "an attorney", "dentists" but "agencies": the slot never takes an article or a
  // plural that depends on the noun, so "a good {sustantivo}" and "{sustantivo} options".
  test("the noun never carries an article or plural that depends on it", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(/\b(a|an)\s+\{sustantivo\}/i);
      expect(text, text).not.toMatch(/\{sustantivo\}(s|es|'s)\b/);
    }
  });

  // The noun can name a place (dental clinic) or a person (dentist), so it is never a location.
  test("the noun reads right for a place and for a professional", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(/\bin\s+(which|what|the)\s+(\w+\s+)?\{sustantivo\}/i);
    }
  });

  // "the United States" but "Canada": the country only goes where no article is needed.
  test("the country never follows a preposition that would need an article", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(/\b(in|to|from|across|of|for|within)\s+\{país\}/i);
    }
  });

  test("neutral American English: no British spellings or terms", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(
        /\b(favourite|colour|centre|neighbourhood|solicitor|estate agent|chemist|holiday|postcode|petrol|hairdresser|whilst|y'all|you guys)\b/i,
      );
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

  test("qualifiers stay in their own intent", () => {
    const qualifiers: Partial<Record<IntentKind, RegExp>> = {
      price:
        /(cheap|affordabl|\bprices?\b|pricing|\bcosts?\b|\bfees?\b|budget|commission|quote|\bfree\b|inexpensive|\brates?\b|\bdeals?\b|how much|charge|tuition|lowest)/i,
      urgency:
        /(\btoday\b|tonight|urgent|emergency|right now|\bnow\b|same[- ]day|24 hour|immediately|\bfast|quick|tomorrow)/i,
      zone: /(\bnear\b|nearby|close to|neighborhood|walking distance|\{zona\})/i,
    };
    for (const { kind, text } of allTexts()) {
      for (const [owner, pattern] of Object.entries(qualifiers)) {
        if (owner !== kind) expect(text, `${kind}: ${text}`).not.toMatch(pattern);
      }
    }
  });

  test("the canonical opens like the observed query it follows", () => {
    expect(intentsOf("food", "local")[0]?.canonical).toBe(
      "Can you recommend a good {sustantivo} in {lugar}?",
    );
    expect(intentsOf("online_national", "national")[0]?.canonical).toBe(
      "What is the best online store for {sustantivo}?",
    );
  });
});

describe("English evidence", () => {
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
