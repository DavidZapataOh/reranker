import type { MeasurementLanguage } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import { agree, type GenderedNoun } from "../src/grammar";
import { placeholderShape } from "../src/templates";
import { instantiate } from "../src/variants";

const fill = (template: string, noun: GenderedNoun, language: MeasurementLanguage) =>
  instantiate(template, { place: "Lyon", zone: null, country: "France", noun, language });

const internal = (fn: () => unknown) =>
  expect(fn).toThrow(expect.objectContaining({ code: "internal" }));

describe("French: gender and elision", () => {
  const dentiste: GenderedNoun = { text: "dentiste", gender: "m" };
  const boulangerie: GenderedNoun = { text: "boulangerie", gender: "f" };
  const hotel: GenderedNoun = { text: "hôtel", gender: "m", elides: true };
  const agence: GenderedNoun = { text: "agence immobilière", gender: "f" };
  const hamburger: GenderedNoun = { text: "hamburger", gender: "m" };

  test.each([
    [dentiste, "le dentiste"],
    [boulangerie, "la boulangerie"],
    [hotel, "l'hôtel"],
    [agence, "l'agence immobilière"],
    [hamburger, "le hamburger"],
  ])("{le|la} + %o", (noun, expected) =>
    expect(fill("{le|la} {sustantivo}", noun, "fr")).toBe(expected),
  );

  test("the article is capitalized at the start of a sentence", () => {
    expect(fill("{Le|La} {sustantivo} à {lugar}", hotel, "fr")).toBe("L'hôtel à Lyon");
    expect(fill("{Le|La} {sustantivo} à {lugar}", boulangerie, "fr")).toBe("La boulangerie à Lyon");
  });

  test("de, du, au and ce change before a vowel", () => {
    expect(fill("Avis de {sustantivo} à {lugar}", hotel, "fr")).toBe("Avis d'hôtel à Lyon");
    expect(fill("Avis de {sustantivo} à {lugar}", dentiste, "fr")).toBe("Avis de dentiste à Lyon");
    expect(fill("Les prix {du|de la} {sustantivo}", hotel, "fr")).toBe("Les prix de l'hôtel");
    expect(fill("Les prix {du|de la} {sustantivo}", boulangerie, "fr")).toBe(
      "Les prix de la boulangerie",
    );
    expect(fill("Je vais {au|à la} {sustantivo}", agence, "fr")).toBe(
      "Je vais à l'agence immobilière",
    );
    expect(fill("Je vais {au|à la} {sustantivo}", dentiste, "fr")).toBe("Je vais au dentiste");
    expect(fill("{ce|cette} {sustantivo}", hotel, "fr")).toBe("cet hôtel");
  });

  test("an adjective between the article and the noun takes the agreement, not the elision", () => {
    const template = "Tu connais {un bon|une bonne} {sustantivo} à {lugar} ?";
    expect(fill(template, hotel, "fr")).toBe("Tu connais un bon hôtel à Lyon ?");
    expect(fill(template, agence, "fr")).toBe("Tu connais une bonne agence immobilière à Lyon ?");
    expect(fill("{Le meilleur|La meilleure} {sustantivo}", agence, "fr")).toBe(
      "La meilleure agence immobilière",
    );
  });
});

describe("Italian: articles and articulated prepositions", () => {
  const dentista: GenderedNoun = { text: "dentista", gender: "m" };
  const studio: GenderedNoun = { text: "studio dentistico", gender: "m" };
  const hotel: GenderedNoun = { text: "hotel", gender: "m" };
  const pasticceria: GenderedNoun = { text: "pasticceria", gender: "f" };
  const agenzia: GenderedNoun = { text: "agenzia immobiliare", gender: "f" };

  test.each([
    [dentista, "il dentista", "un dentista", "nel dentista", "dal dentista"],
    [
      studio,
      "lo studio dentistico",
      "uno studio dentistico",
      "nello studio dentistico",
      "dallo studio dentistico",
    ],
    [hotel, "l'hotel", "un hotel", "nell'hotel", "dall'hotel"],
    [pasticceria, "la pasticceria", "una pasticceria", "nella pasticceria", "dalla pasticceria"],
    [
      agenzia,
      "l'agenzia immobiliare",
      "un'agenzia immobiliare",
      "nell'agenzia immobiliare",
      "dall'agenzia immobiliare",
    ],
  ])("%o", (noun, article, indefinite, nel, dal) => {
    expect(fill("{il|la} {sustantivo}", noun, "it")).toBe(article);
    expect(fill("{un|una} {sustantivo}", noun, "it")).toBe(indefinite);
    expect(fill("{nel|nella} {sustantivo}", noun, "it")).toBe(nel);
    expect(fill("{dal|dalla} {sustantivo}", noun, "it")).toBe(dal);
  });

  test("the elided article keeps the capital", () =>
    expect(fill("{Il|La} {sustantivo} migliore", agenzia, "it")).toBe(
      "L'agenzia immobiliare migliore",
    ));
});

describe("Portuguese: articles with prepositions", () => {
  const dentista: GenderedNoun = { text: "dentista", gender: "m" };
  const padaria: GenderedNoun = { text: "padaria", gender: "f" };

  test("no/na, do/da and um bom/uma boa follow the gender, with no elision", () => {
    expect(fill("Atendimento {no|na} {sustantivo}", dentista, "pt")).toBe(
      "Atendimento no dentista",
    );
    expect(fill("Atendimento {no|na} {sustantivo}", padaria, "pt")).toBe("Atendimento na padaria");
    expect(fill("Preços {do|da} {sustantivo}", padaria, "pt")).toBe("Preços da padaria");
    const template = "Você me indica {um bom|uma boa} {sustantivo} em {lugar}?";
    expect(fill(template, dentista, "pt")).toBe("Você me indica um bom dentista em Lyon?");
    expect(fill(template, padaria, "pt")).toBe("Você me indica uma boa padaria em Lyon?");
    const hotel: GenderedNoun = { text: "hotel", gender: "m" };
    expect(fill("Preços {do|da} {sustantivo}", hotel, "pt")).toBe("Preços do hotel");
  });
});

describe("German: case and capitalized nouns", () => {
  const zahnarzt: GenderedNoun = { text: "Zahnarzt", gender: "m" };
  const werkstatt: GenderedNoun = { text: "Autowerkstatt", gender: "f" };
  const hotel: GenderedNoun = { text: "Hotel", gender: "n" };

  test.each([
    [
      zahnarzt,
      "Kannst du mir einen guten Zahnarzt in Lyon empfehlen?",
      "Welcher Zahnarzt",
      "beim Zahnarzt",
    ],
    [
      werkstatt,
      "Kannst du mir eine gute Autowerkstatt in Lyon empfehlen?",
      "Welche Autowerkstatt",
      "bei der Autowerkstatt",
    ],
    [hotel, "Kannst du mir ein gutes Hotel in Lyon empfehlen?", "Welches Hotel", "beim Hotel"],
  ])("%o", (noun, accusative, nominative, dative) => {
    expect(
      fill(
        "Kannst du mir {einen guten|eine gute|ein gutes} {sustantivo} in {lugar} empfehlen?",
        noun,
        "de",
      ),
    ).toBe(accusative);
    expect(fill("{Welcher|Welche|Welches} {sustantivo}", noun, "de")).toBe(nominative);
    expect(fill("{beim|bei der|beim} {sustantivo}", noun, "de")).toBe(dative);
  });

  test("a German noun written in lower case is refused", () =>
    internal(() => fill("{der|die|das} {sustantivo}", { text: "zahnarzt", gender: "m" }, "de")));
});

describe("agreement groups", () => {
  test("Spanish and English nouns are bare strings and their templates never agree", () => {
    expect(agree("¿Qué {sustantivo} me recomiendas?", "panadería", "es")).toBe(
      "¿Qué {sustantivo} me recomiendas?",
    );
    internal(() => agree("{un|una} {sustantivo}", "panadería", "es"));
  });

  test("a bare French noun still elides de, with no gender to agree with", () => {
    const shop = "Boutique en ligne de {sustantivo}";
    expect(agree(shop, "accessoires", "fr")).toBe("Boutique en ligne d'{sustantivo}");
    expect(agree(shop, "vêtements", "fr")).toBe(shop);
    internal(() => agree("{un|une} {sustantivo}", "vêtements", "fr"));
  });

  test.each([
    [
      "a group with the wrong number of forms",
      "{einen|eine} {sustantivo}",
      { text: "Zahnarzt", gender: "m" },
      "de",
    ],
    ["a neuter noun outside German", "{le|la} {sustantivo}", { text: "hôtel", gender: "n" }, "fr"],
    [
      "a gendered noun in a language that never agrees",
      "{sustantivo}",
      { text: "x", gender: "m" },
      "en",
    ],
  ] as const)("%s is an internal error", (_, template, noun, language) =>
    internal(() => agree(template, noun, language)),
  );

  test("a group is a word, not a place placeholder", () => {
    expect(placeholderShape("{Quel|Quelle} {sustantivo} à {lugar} ?", "local")).toBe("ok");
    expect(placeholderShape("{Quel|} {sustantivo} à {lugar} ?", "local")).toBe(
      "unknown_placeholder",
    );
  });
});
