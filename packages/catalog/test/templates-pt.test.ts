import { z } from "@reranker/schema";
import {
  CategoryArchetype,
  IntentKind,
  ParaphraseFormat,
  QuestionScope,
} from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import evidence from "../data/templates/2026.11.0.pt.evidence.json" with { type: "json" };
import data from "../data/templates/2026.11.0.pt.json" with { type: "json" };
import { ARCHETYPE_SCOPES, ARCHETYPE_SLATES } from "../src/archetypes";
import { seedCategories } from "../src/categories";
import { type GuardContext, guardParaphrase } from "../src/generate/guards";
import type { GenderedNoun } from "../src/grammar";
import { brandTemplates, fallbackTemplates, placeholderShape } from "../src/templates";
import { instantiate } from "../src/variants";

// Brazilian Portuguese questions sit next to the Spanish file as <version>.pt.json, with the same
// shape and placeholder names; <version>.pt.evidence.json is their audit trail.
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
  language: z.literal("pt"),
  patterns: z.record(
    z.string(),
    z.object({
      support: z.enum(["observed", "adapted", "unsupported"]),
      evidence: z.array(
        z.object({ source: z.string(), market: z.literal("br"), query: z.string().min(1) }),
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

describe("Portuguese fallback templates", () => {
  test("the loader serves this file", () => {
    for (const { archetype, scope } of entries) {
      expect(fallbackTemplates(archetype, scope, "pt")).toEqual(intentsOf(archetype, scope));
    }
    expect(brandTemplates("pt")).toEqual(TEMPLATES.brand);
  });

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

  // "um bom dentista" but "uma boa padaria": words that agree with the noun are groups, masculine
  // first, and the noun itself never takes an article, a contraction or a plural.
  test("every agreement group has a masculine and a feminine form", () => {
    for (const { text } of allTexts()) {
      for (const [, group] of text.matchAll(/\{([^{}]*\|[^{}]*)\}/g)) {
        expect(group?.split("|"), text).toHaveLength(2);
      }
    }
  });

  test("the noun never carries an article, a contraction or a plural outside a group", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(
        /(?<![{|])\b(o|a|os|as|um|uma|no|na|do|da|ao|à|pelo|pela|num|numa)\s+\{sustantivo\}/i,
      );
      expect(text, text).not.toMatch(/\{sustantivo\}(s|es)\b/);
    }
  });

  // A web-only store's noun names what it sells, which can be plural ("roupas"): never agree with it.
  test("online stores' questions never agree with the product", () => {
    for (const { text } of textsOf("online_national", "national")) expect(text).not.toContain("|");
  });

  // "no Brasil" needs an article, so the country only goes where none is needed.
  test("the country never follows a preposition that would need an article", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(/\b(em|no|na|de|do|da|para|pelo|pela)\s+\{país\}/i);
    }
  });

  const dentista: GenderedNoun = { text: "dentista", gender: "m" };
  const padaria: GenderedNoun = { text: "padaria", gender: "f" };

  test.each([dentista, padaria])("every text reads as a sentence for %o", (noun) => {
    for (const { archetype, text } of allTexts()) {
      const filled = instantiate(text, {
        place: "Belo Horizonte",
        zone: "Savassi",
        country: "Brasil",
        noun: archetype === "online_national" ? "roupas" : noun,
        language: "pt",
      });
      expect(filled, text).not.toMatch(/[{}|]|\s{2}|\s[?,.]/);
    }
  });

  test("agreement follows the noun's gender", () => {
    const text = "Onde encontrar {um bom|uma boa} {sustantivo} {barato|barata} em {lugar}?";
    const ctx = { place: "São Paulo", zone: null, country: "Brasil", language: "pt" as const };
    expect(instantiate(text, { ...ctx, noun: dentista })).toBe(
      "Onde encontrar um bom dentista barato em São Paulo?",
    );
    expect(instantiate(text, { ...ctx, noun: padaria })).toBe(
      "Onde encontrar uma boa padaria barata em São Paulo?",
    );
  });

  test("every template passes the Portuguese guards of its own intent", () => {
    const rejected: string[] = [];
    for (const { archetype, scope, kind, text } of allTexts()) {
      const ctx: GuardContext = {
        scope,
        kind,
        language: "pt",
        noun: "padaria",
        synonyms: [],
        countryName: "Brasil",
        otherPlaceNames: new Set(["Curitiba", "Recife"]),
        blockedNames: new Set(),
      };
      const r = guardParaphrase({ text, format: "keyword", generator: "template" }, ctx);
      if (!r.ok) rejected.push(`${archetype}/${scope}/${kind} ${r.guard}: ${text}`);
    }
    expect(rejected).toEqual([]);
  });

  test("3 to 40 words, no personal data", () => {
    for (const { text } of allTexts()) {
      const words = text.split(/\s+/).filter(Boolean).length;
      expect(words, text).toBeGreaterThanOrEqual(3);
      expect(words, text).toBeLessThanOrEqual(40);
      expect(text).not.toMatch(/\d{7,}|@/);
    }
  });

  test("neutral Brazilian Portuguese: você, never tu or European forms", () => {
    for (const { text } of allTexts()) {
      expect(text, text).not.toMatch(
        /\b(tu|te|contigo|vós|recomendas|estás|telemóvel|autocarro)\b/i,
      );
    }
  });

  test("qualifiers stay in their own intent", () => {
    const qualifiers: Partial<Record<IntentKind, RegExp>> = {
      price:
        /(barat|\bpreços?\b|\bcust|gratuit|grátis|comissão|bolsa|orçamento|mensalidade|diária)/i,
      urgency: /(\bhoje\b|\bagora\b|24 horas|emergência|urgência|domingo|mesmo dia|rápid)/i,
      zone: /(\bperto\b|próxim|bairro|\{zona\})/i,
    };
    for (const { kind, text } of allTexts()) {
      for (const [owner, pattern] of Object.entries(qualifiers)) {
        if (owner !== kind) expect(text, `${kind}: ${text}`).not.toMatch(pattern);
      }
    }
  });

  test("the canonical opens like the observed query it follows", () => {
    expect(intentsOf("food", "local")[0]?.canonical).toBe(
      "Qual {sustantivo} você recomenda em {lugar}?",
    );
    expect(intentsOf("online_national", "national")[0]?.canonical).toBe(
      "Qual é a melhor loja online de {sustantivo}?",
    );
  });
});

describe("Portuguese seed nouns", () => {
  test("nouns follow Brazilian searches and carry their gender", () => {
    const pt = (key: string) => seedCategories().find((c) => c.key === key)?.languages.pt;
    expect(pt("dental_clinic")?.noun).toEqual({ text: "dentista", gender: "m" });
    expect(pt("car_repair")?.noun).toEqual({ text: "mecânico", gender: "m" });
    expect(pt("real_estate_agency")?.noun).toEqual({ text: "imobiliária", gender: "f" });
    expect(pt("online_store")?.noun).toBeNull();
    for (const c of seedCategories()) {
      const { noun, synonyms } = c.languages.pt;
      if (noun) expect(noun.text).toBe(noun.text.toLowerCase());
      for (const s of synonyms) expect(s).toBe(s.toLowerCase());
      expect(synonyms).not.toContain(noun?.text);
    }
  });

  test("every local template reads right with every seed noun", () => {
    for (const c of seedCategories()) {
      const noun = c.languages.pt.noun;
      if (!noun) continue;
      for (const { text } of textsOf(c.archetype, "local")) {
        const filled = instantiate(text, {
          place: "São Paulo",
          zone: "Moema",
          country: "Brasil",
          noun,
          language: "pt",
        });
        expect(filled).not.toMatch(/[{}|]/);
      }
    }
  });
});

describe("Portuguese evidence", () => {
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
