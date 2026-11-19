import { describe, expect, test } from "vitest";
import { locateQuote, toExtractedMentions } from "../src/quote";
import type { MentionsOutput } from "../src/schema";

type Mention = MentionsOutput["mentions"][number];

const m = (name: string, quote: string, over: Partial<Mention> = {}): Mention => ({
  name,
  quote,
  stance: "recommendation",
  entityKind: "business",
  sentiment: "positive",
  locationHint: null,
  citedUrls: [],
  ...over,
});

const out = (
  rows: [string, string, Mention["stance"], Mention["entityKind"]][],
): MentionsOutput => ({
  answerKind: "names_entities",
  mentions: rows.map(([name, quote, stance, entityKind]) => m(name, quote, { stance, entityKind })),
});

describe("locateQuote", () => {
  test("matches across typographic quotes, accents and case, with UTF-16 offsets on the original", () => {
    const md = "🦷 Te recomiendo “Clínica Sonrisas” en Laureles.";
    const at = locateQuote(md, '"clinica sonrisas"');
    expect(at).not.toBeNull();
    expect(md.slice(at?.start, at?.end)).toBe("“Clínica Sonrisas”");
  });

  test("first occurrence wins when the quote repeats", () => {
    const md = "Sonrisas es buena. También Sonrisas Norte.";
    expect(locateQuote(md, "Sonrisas")).toEqual({ start: 0, end: 8 });
  });

  test("decomposed accents and runs of whitespace still match the original span", () => {
    const md = "Pregunta por la Dra.\n\n  Ana Gómez, en El Poblado.";
    const at = locateQuote(md, "Dra. Ana Gómez");
    expect(md.slice(at?.start, at?.end)).toBe("Dra.\n\n  Ana Gómez");
  });

  test("markdown emphasis inside the answer does not hide a quote", () => {
    const md = "1. **Clínica Sonrisas** — atención *rápida* en Laureles.";
    const at = locateQuote(md, "Clínica Sonrisas — atención rápida");
    expect(md.slice(at?.start, at?.end)).toBe("Clínica Sonrisas** — atención *rápida");
  });

  test("letters that change length when lowercased map back to the original", () => {
    const md = "Visita İzmir Kebap hoy.";
    const at = locateQuote(md, "izmir kebap");
    expect(md.slice(at?.start, at?.end)).toBe("İzmir Kebap");
  });

  test("a quote only matches whole words", () => {
    expect(locateQuote("Cruzeiro es otra cosa.", "Cruz")).toBeNull();
    expect(locateQuote("Ve a Cruzeiro o a Cruz.", "cruz")).toEqual({ start: 18, end: 22 });
  });

  test("an empty or missing quote is not found", () => {
    expect(locateQuote("Ve a Clínica Sonrisas.", "  ")).toBeNull();
    expect(locateQuote("Ve a Clínica Sonrisas.", "Clínica Fantasma")).toBeNull();
  });
});

describe("toExtractedMentions", () => {
  test("a quote that is not in the answer drops the mention and counts a miss", () => {
    const r = toExtractedMentions("Ve a Clínica Sonrisas.", {
      answerKind: "names_entities",
      mentions: [m("Sonrisas", "Clínica Sonrisas"), m("Fantasma", "Clínica Fantasma")],
    });
    expect(r.mentions.map((x) => x.name)).toEqual(["Sonrisas"]);
    expect(r.quoteMisses).toBe(1);
  });

  test("ordinal counts only recommended commercial entities, by first appearance", () => {
    const md = "Según Booking, ve a A, luego B; evita C. Cerca del Hotel D.";
    const r = toExtractedMentions(
      md,
      out([
        ["Booking", "Booking", "incidental", "platform"],
        ["B", "B", "recommendation", "business"],
        ["A", "A", "recommendation", "business"],
        ["C", "C", "negative", "business"],
        ["Hotel D", "Hotel D", "incidental", "business"],
      ]),
    );
    expect(Object.fromEntries(r.mentions.map((x) => [x.name, x.ordinal]))).toEqual({
      Booking: null,
      A: 1,
      B: 2,
      C: null,
      "Hotel D": null,
    });
  });

  test("professionals and chains are ranked; platforms and media are not", () => {
    const md = "Dra. Ana Gómez, Cruz Verde, Rappi y El Tiempo.";
    const r = toExtractedMentions(
      md,
      out([
        ["Rappi", "Rappi", "recommendation", "platform"],
        ["El Tiempo", "El Tiempo", "recommendation", "directory_or_media"],
        ["Cruz Verde", "Cruz Verde", "recommendation", "chain"],
        ["Dra. Ana Gómez", "Dra. Ana Gómez", "recommendation", "professional"],
      ]),
    );
    expect(r.mentions.map((x) => [x.name, x.ordinal])).toEqual([
      ["Dra. Ana Gómez", 1],
      ["Cruz Verde", 2],
      ["Rappi", null],
      ["El Tiempo", null],
    ]);
  });

  test("keeps the exact span of the answer, the normalized name and the model's fields", () => {
    const md = "Te recomiendo “Clínica Sonrisas S.A.S.” en Laureles.";
    const r = toExtractedMentions(md, {
      answerKind: "names_entities",
      mentions: [
        m("Clínica Sonrisas S.A.S.", '"clinica sonrisas s.a.s."', {
          locationHint: "Laureles",
          citedUrls: ["https://sonrisas.example.co/"],
        }),
      ],
    });
    expect(r).toEqual({
      quoteMisses: 0,
      mentions: [
        {
          name: "Clínica Sonrisas S.A.S.",
          nameNorm: "clinica sonrisas",
          quote: "“Clínica Sonrisas S.A.S.”",
          startOffset: 14,
          endOffset: 39,
          ordinal: 1,
          stance: "recommendation",
          entityKind: "business",
          sentiment: "positive",
          locationHint: "Laureles",
          citedUrls: ["https://sonrisas.example.co/"],
        },
      ],
    });
  });

  test("an answer without entities yields no mentions", () =>
    expect(toExtractedMentions("No sé.", { answerKind: "no_entities", mentions: [] })).toEqual({
      mentions: [],
      quoteMisses: 0,
    }));
});
