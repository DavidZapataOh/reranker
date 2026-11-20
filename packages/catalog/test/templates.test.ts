import {
  CategoryArchetype,
  type IntentKind,
  MeasurementLanguage,
  ParaphraseFormat,
  type QuestionScope,
} from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import evidence from "../data/templates/2026.11.0.evidence.json" with { type: "json" };
import { ARCHETYPE_SCOPES, ARCHETYPE_SLATES, registerFor } from "../src/archetypes";
import { MeasurementLanguageError } from "../src/language";
import {
  brandTemplates,
  canonicalTemplate,
  fallbackTemplates,
  placeholderShape,
  TEMPLATE_LANGUAGES,
  templatesVersion,
} from "../src/templates";

// The audit trail of the templates: which observed query phrasings each text follows.
const EVIDENCE = evidence as {
  patterns: Record<string, { support: string; evidence: unknown[] }>;
  templates: Record<string, string[][]>;
};

const entries = CategoryArchetype.options.flatMap((archetype) =>
  ARCHETYPE_SCOPES[archetype].map((scope) => ({ archetype, scope })),
);

function textsOf(archetype: CategoryArchetype, scope: QuestionScope) {
  return fallbackTemplates(archetype, scope, "es").flatMap((i) => [
    { kind: i.kind, text: i.canonical },
    ...i.paraphrases.map((p) => ({ kind: i.kind, text: p.text })),
  ]);
}

const allTemplateTexts = () => entries.flatMap(({ archetype, scope }) => textsOf(archetype, scope));

describe("placeholderShape", () => {
  test.each<[string, QuestionScope, ReturnType<typeof placeholderShape>]>([
    ["¿Qué {sustantivo} me recomiendas en {lugar}?", "local", "ok"],
    ["¿Qué {sustantivo} queda cerca de {zona} en {lugar}?", "local", "ok"],
    ["¿Qué {sustantivo} me recomiendas?", "local", "place_count"],
    ["{sustantivo} en {lugar} o en {lugar}", "local", "place_count"],
    ["{sustantivo} entre {zona} y {zona} en {lugar}", "local", "place_count"],
    ["{sustantivo} en {lugar}, {país}", "local", "wrong_scope"],
    ["¿Cuál es la mejor tienda online de {sustantivo} en {país}?", "national", "ok"],
    ["Tienda de {sustantivo} con envíos a todo el país", "national", "ok"],
    ["{sustantivo} en {país} o {país}", "national", "place_count"],
    ["{sustantivo} en {lugar}", "national", "wrong_scope"],
    ["{sustantivo} cerca de {zona}", "national", "wrong_scope"],
    ["¿{business} en {lugar} es confiable?", "local", "unknown_placeholder"],
    ["{sustantivo} en {lugar} {ciudad}", "local", "unknown_placeholder"],
    ["{sustantivo en {lugar}", "local", "unknown_placeholder"],
  ])("%s (%s) → %s", (text, scope, expected) =>
    expect(placeholderShape(text, scope)).toBe(expected),
  );
});

describe("fallback templates", () => {
  // Every language's templates, as each lands.
  test.each(TEMPLATE_LANGUAGES.flatMap((language) => entries.map((e) => ({ ...e, language }))))(
    "$language $archetype/$scope covers its slate and passes the guards",
    ({ archetype, scope, language }) => {
      const t = fallbackTemplates(archetype, scope, language);
      expect(t.map((i) => i.kind)).toEqual([...ARCHETYPE_SLATES[archetype]]);
      expect(new Set(t.map((i) => i.slug)).size).toBe(t.length);
      for (const i of t) {
        expect(i.paraphrases.length).toBeGreaterThanOrEqual(8);
        for (const f of ParaphraseFormat.options) {
          expect(i.paraphrases.filter((p) => p.format === f).length).toBeGreaterThanOrEqual(2);
        }
        const texts = [i.canonical, ...i.paraphrases.map((p) => p.text)];
        // The canonical is its own paraphrase, so 8 more keep 8 distinct variants without personas.
        expect(new Set(texts).size).toBe(texts.length);
        for (const text of texts) {
          expect(placeholderShape(text, scope)).toBe("ok");
          expect(text).toContain("{sustantivo}");
          expect(text.includes("{zona}")).toBe(i.kind === "zone");
        }
      }
    },
  );

  test("every archetype has templates for each scope it is asked in", () => {
    expect(ARCHETYPE_SCOPES.online_national).toEqual(["national"]);
    expect(ARCHETYPE_SCOPES.local_retail).toEqual(["local", "national"]);
    for (const a of CategoryArchetype.options)
      expect(ARCHETYPE_SCOPES[a]).toContain(a === "online_national" ? "national" : "local");
  });

  test("a scope the archetype is never asked in is a programming error", () => {
    expect(() => fallbackTemplates("food", "national", "es")).toThrow();
    expect(() => fallbackTemplates("online_national", "local", "es")).toThrow();
  });

  test("templates contain no Colombian regionalisms in the neutral register", () => {
    for (const { text } of allTemplateTexts()) {
      expect(text).not.toMatch(
        /\b(parce|parcero|prepagada|EPS|arriendo|contraentrega|valoración)\b/i,
      );
    }
  });

  test("the noun never carries a gendered article: it can be masculine or feminine", () => {
    for (const { text } of allTemplateTexts()) {
      expect(text).not.toMatch(/\b(el|la|los|las|un|una|algún|alguna)\s+\{sustantivo\}/i);
      expect(text, text).not.toMatch(/\b(el|la|un|una|buen|buena)\s+mejor\s+\{sustantivo\}/i);
      // "Comprar X barato" is an adverb and stays as it is.
      expect(text, text).not.toMatch(
        /(?<!compr\w*\s+)\{sustantivo\}\s+(barat|abiert|económic|recomendad|especializad|cercan|ubicad|vigilad)[oa]s?\b/i,
      );
    }
  });

  // The noun can name a place (clínica odontológica) or a person (odontólogo), so it is never a location.
  test("the noun reads right for a place and for a professional", () => {
    for (const { text } of allTemplateTexts()) {
      expect(text, text).not.toMatch(/\ben\s+(qué|cuál|el|la)\s+\{sustantivo\}/i);
    }
  });

  test("every text names the observed phrasings it follows", () => {
    const declared = new Set(Object.keys(EVIDENCE.patterns));
    for (const { archetype, scope } of entries) {
      for (const i of fallbackTemplates(archetype, scope, "es")) {
        const keys = EVIDENCE.templates[`${archetype}/${scope}/${i.kind}`];
        expect(keys, `${archetype}/${scope}/${i.kind}`).toHaveLength(1 + i.paraphrases.length);
        for (const k of (keys ?? []).flat()) expect(declared).toContain(k);
      }
    }
    for (const [key, p] of Object.entries(EVIDENCE.patterns)) {
      expect(p.support === "unsupported" || p.evidence.length > 0, key).toBe(true);
    }
  });

  test("3 to 40 words, sentence case, no personal data", () => {
    for (const { text } of allTemplateTexts()) {
      const words = text.split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThanOrEqual(3);
      expect(words).toBeLessThanOrEqual(40);
      expect(text).not.toMatch(/\d{7,}|@/);
    }
  });

  test("qualifiers stay in their own intent", () => {
    const qualifiers: Partial<Record<IntentKind, RegExp>> = {
      price: /(barat|económic|precio|costo|tarifa|presupuesto|comisi|cotizaci|gratis)/i,
      urgency: /(\bhoy\b|urgen|\bya\b|inmediat|24 horas|exprés|rápid|mañana|al día siguiente)/i,
      zone: /(\bcerca\b|sector|distancia|\{zona\})/i,
    };
    for (const { kind, text } of allTemplateTexts()) {
      for (const [owner, pattern] of Object.entries(qualifiers)) {
        if (owner !== kind) expect(text, `${kind}: ${text}`).not.toMatch(pattern);
      }
    }
  });

  test("the register matches the archetype", () => {
    for (const { archetype, scope } of entries) {
      const forbidden =
        registerFor(archetype) === "usted"
          ? /\b(recomiendas|sugieres|Dame|Recomiéndame|Hazme|Quiero)\b/
          : /\b(recomienda|sugiere|Deme|Recomiéndeme|Hágame|Quisiera)\b/;
      for (const { text } of textsOf(archetype, scope)) expect(text, text).not.toMatch(forbidden);
    }
  });
});

describe("canonicalTemplate", () => {
  test("the archetype canonical is the one of its fallback templates", () => {
    for (const { archetype, scope } of entries) {
      for (const i of fallbackTemplates(archetype, scope, "es")) {
        expect(canonicalTemplate(archetype, i.kind, scope, "es")).toBe(i.canonical);
      }
    }
  });

  test("canonical questions from the spec", () => {
    expect(canonicalTemplate("food", "discovery", "local", "es")).toBe(
      "¿Qué {sustantivo} me recomiendas en {lugar}?",
    );
    expect(canonicalTemplate("online_national", "discovery", "national", "es")).toBe(
      "¿Cuál es la mejor tienda online de {sustantivo} en {país}?",
    );
    expect(canonicalTemplate("health", "discovery", "local", "es")).toBe(
      "¿Qué {sustantivo} me recomiendas en {lugar}?",
    );
  });

  test("a kind outside the slate or brand is a programming error", () => {
    expect(() => canonicalTemplate("food", "insurance_or_payment", "local", "es")).toThrow();
    expect(() => canonicalTemplate("food", "brand", "local", "es")).toThrow();
  });
});

describe("languages without templates", () => {
  test("Spanish is written; the rest fail closed until theirs land", () => {
    expect(TEMPLATE_LANGUAGES).toContain("es");
    expect(templatesVersion("es")).toBe("2026.11.0");
  });

  test.each(MeasurementLanguage.options.filter((l) => !TEMPLATE_LANGUAGES.includes(l)))(
    "%s refuses with a typed error instead of asking in another language",
    (language) => {
      for (const call of [
        () => fallbackTemplates("health", "local", language),
        () => canonicalTemplate("health", "discovery", "local", language),
        () => templatesVersion(language),
        () => brandTemplates(language),
      ]) {
        const error = (() => {
          try {
            call();
          } catch (e) {
            return e;
          }
        })();
        expect(error).toBeInstanceOf(MeasurementLanguageError);
        expect(error).toMatchObject({ language, gap: "no_templates", code: "validation_failed" });
      }
    },
  );
});

test("brand templates stay outside the score and name the business, never a person", () => {
  expect(brandTemplates("es")).toEqual({
    "brand.trust": "¿{business} en {lugar} es confiable?",
    "brand.opinion": "¿Qué opinas de {business}?",
  });
});
