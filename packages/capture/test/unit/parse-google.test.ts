import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { EngineAnswer, PARSER_VERSIONS, safeParseAnswer } from "../../src/answer";
import { parseAiMode } from "../../src/dataforseo/parse/ai-mode";
import { parseAiOverview } from "../../src/dataforseo/parse/ai-overview";

// `live/` holds production answers to Spanish local questions; `sandbox/` the canned ones.
const recorded = (path: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/recorded/${path}`, import.meta.url)));

const GOOGLE = {
  channel: "ui-vendor",
  provider: "dataforseo",
  modelReported: null,
  searchQueries: "unavailable",
} as const;

// The documented elements production has not returned yet: an expanded element whose components
// carry references, and a shopping element. Printed the way the API prints (escaped slashes).
const DOCUMENTED =
  new TextEncoder().encode(`{"status_code":20000,"tasks":[{"status_code":20000,"result":[{"type":"ai_mode","items":[
  {"type":"ai_overview","markdown":"Colchones en Bogot\\u00e1","references":null,"items":[
    {"type":"ai_overview_expanded_element","title":"Tiendas","components":[
      {"type":"ai_overview_expanded_component","references":[
        {"type":"ai_overview_reference","source":"Alkosto","domain":"www.alkosto.com","url":"https:\\/\\/www.alkosto.com\\/colchones","title":"Colchones | Alkosto"},
        {"type":"ai_overview_reference","source":null,"domain":null,"url":null,"title":null}]}]},
    {"type":"ai_overview_shopping","items":[
      {"type":"ai_overview_shopping_element","product_id":"4982114618355576541","title":"Colch\\u00f3n Kline","price":{"current":899900,"currency":"COP"}}]}]}]}]}]}`);

describe("parseAiOverview", () => {
  test("a production AI Overview parses its references as cited sources", () => {
    const a = parseAiOverview(recorded("live/ai-overview-pico-y-placa-medellin.json"));
    expect(EngineAnswer.parse(a)).toEqual(a);
    expect(a).toMatchObject({
      ...GOOGLE,
      parserVersion: `ai-overview@${PARSER_VERSIONS["google-ai-overview"]}`,
      engine: "google-ai-overview",
      present: true,
      localBusinesses: [],
      products: [],
    });
    expect(a.markdown.startsWith("Hoy, **jueves 19 de noviembre de 2026** , el pico y placa")).toBe(
      true,
    );
    expect(a.sources.map((s) => s.domain)).toEqual([
      "www.medellin.gov.co",
      "google.com",
      "mundimotos.com",
      "google.com",
    ]);
    expect(a.sources[0]).toEqual({
      url: "https://www.medellin.gov.co/es/secretaria-de-movilidad/pico-y-placa-medellin-2023-segundo-semestre/",
      domain: "www.medellin.gov.co",
      title: "Pico y Placa Medellín 2026, segundo semestre",
      cited: true,
    });
  });

  test("goto links stay as returned and Shopping cards become products, not sources", () => {
    const a = parseAiOverview(recorded("live/ai-overview-colchon-bogota.json"));
    expect(EngineAnswer.parse(a)).toEqual(a);
    // resolveRedirects adds where each google.com/goto link leads.
    expect(a.sources.map((s) => s.domain)).toEqual([
      "www.tiktok.com",
      "google.com",
      "google.com",
      "google.com",
      "google.com",
    ]);
    expect(a.sources[1]?.url.startsWith("https://google.com/goto?url=")).toBe(true);
    expect(a.products).toHaveLength(8);
    expect(a.products?.[0]).toMatchObject({
      type: "ai_overview_reference",
      title: "Colchón Kline Sencillo Resortado Esencial One 100 x 190 cm",
    });
  });

  test.each([
    "live/ai-overview-abogado-laboral-cdmx.json",
    "live/ai-overview-clima-medellin.json",
    "sandbox/ai-overview-live.json",
  ])(
    "a results page without an AI Overview is a present:false answer, not an error (%s)",
    (path) => {
      const a = parseAiOverview(recorded(path));
      expect(EngineAnswer.parse(a)).toEqual(a);
      expect(a).toEqual({
        ...GOOGLE,
        parserVersion: "ai-overview@1",
        engine: "google-ai-overview",
        present: false,
        markdown: "",
        sources: [],
      });
    },
  );

  test("a provider error without a result is recorded as a parse error", () => {
    // Recorded as returned: 40101 "Internal SE Server Error." inside an HTTP 200.
    expect(
      safeParseAnswer(parseAiOverview, recorded("live/ai-overview-dentistas-medellin.json")),
    ).toEqual({ answer: null, error: "Error: the response holds no result" });
  });
});

describe("parseAiMode", () => {
  test("place cards become local businesses and the web pages stay sources", () => {
    const a = parseAiMode(recorded("live/ai-mode-dentistas-medellin.json"));
    expect(EngineAnswer.parse(a)).toEqual(a);
    expect(a).toMatchObject({
      ...GOOGLE,
      parserVersion: `ai-mode@${PARSER_VERSIONS["google-ai-mode"]}`,
      engine: "google-ai-mode",
      present: true,
    });
    expect(a.markdown.startsWith("En Medellín encuentras una gran oferta de odontólogos")).toBe(
      true,
    );
    expect(a.sources).toEqual([
      {
        url: "https://www.doctoralia.co/perfil/juan-carlos-ramirez-4?prevent-patient-app-banner=true&utm_source=google&utm_medium=gmb&utm_campaign=140501&utm_content=book_visit#highlight-calendar",
        domain: "www.doctoralia.co",
        title: "Endodoncias",
        cited: true,
      },
    ]);
    expect(a.localBusinesses).toHaveLength(9);
    expect(a.localBusinesses?.[0]).toEqual({
      name: "Odontoespecialistas",
      url: "https://www.google.com/searchviewer/10?svid=CCYSECoOCgwvZy8xcHRfYnA2aGMYCg",
    });
  });

  test("references of every element are cited once each, in reading order", () => {
    const a = parseAiMode(recorded("live/ai-mode-abogado-laboral-cdmx.json"));
    expect(EngineAnswer.parse(a)).toEqual(a);
    expect(a.sources.map((s) => s.url)).toEqual([
      "https://ccl.cdmx.gob.mx/servicios/servicio/orientacion-y-asesoria",
      "http://gerardocuellaryabogados.com/",
      "https://abogadosencdmx.com/especialidades/derecho-laboral-cdmx/",
    ]);
    expect(a.localBusinesses).toEqual([]);
  });

  test.each([
    "live/ai-mode-colchon-bogota.json",
    "live/ai-mode-pico-y-placa-medellin.json",
    "sandbox/ai-mode-live.json",
  ])("never repeats the prompt as a query nor names a model (%s)", (path) => {
    const a = parseAiMode(recorded(path));
    expect(EngineAnswer.parse(a)).toEqual(a);
    expect(a.present).toBe(true);
    expect(a.markdown.length).toBeGreaterThan(0);
    expect(a.searchQueries).toBe("unavailable");
    expect(a.modelReported).toBeNull();
    expect(a.sources.every((s) => s.cited && s.domain !== "www.google.com")).toBe(true);
  });

  test("expanded components and shopping elements follow the documented schema", () => {
    const a = parseAiMode(DOCUMENTED);
    expect(EngineAnswer.parse(a)).toEqual(a);
    expect(a.sources).toEqual([
      {
        url: "https://www.alkosto.com/colchones",
        domain: "www.alkosto.com",
        title: "Colchones | Alkosto",
        cited: true,
      },
    ]);
    expect(a.products).toEqual([
      {
        type: "ai_overview_shopping_element",
        product_id: "4982114618355576541",
        title: "Colchón Kline",
        price: { current: 899900, currency: "COP" },
      },
    ]);
  });

  test("parsing is pure: the same bytes give the same answer and stay untouched", () => {
    const bytes = recorded("live/ai-mode-colchon-bogota.json");
    const copy = bytes.slice();
    expect(parseAiMode(bytes)).toEqual(parseAiMode(bytes));
    expect(Buffer.from(bytes).equals(Buffer.from(copy))).toBe(true);
  });
});
