import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { EngineAnswer, PARSER_VERSIONS } from "../../src/answer";
import { parseGemini } from "../../src/dataforseo/parse/gemini";

const recorded = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/recorded/sandbox/${name}`, import.meta.url)));

const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGx9kL2";

// The sandbox recordings carry no sources, so this body follows the documented `gemini_source`,
// printed the way the sandbox prints (four spaces, escaped slashes).
const WITH_SOURCES = new TextEncoder().encode(`{
    "status_code": 20000,
    "tasks": [
        {
            "status_code": 20000,
            "result": [
                {
                    "model": "3.5 Flash",
                    "markdown": "La Cl\\u00ednica Dental Ejemplo atiende en El Poblado.",
                    "sources": [
                        { "type": "gemini_source", "title": "Cl\\u00ednica Dental Ejemplo", "domain": "clinicaejemplo.co", "url": "${REDIRECT.replaceAll("/", "\\/")}" },
                        { "type": "gemini_source", "title": null, "domain": null, "url": "https:\\/\\/odontologos.co\\/medellin" },
                        { "type": "gemini_source", "url": null }
                    ],
                    "items": [
                        { "type": "gemini_text", "markdown": "La Cl\\u00ednica", "sources": [
                            { "type": "gemini_source", "title": "Cl\\u00ednica Dental Ejemplo", "domain": "clinicaejemplo.co", "url": "${REDIRECT.replaceAll("/", "\\/")}" },
                            { "type": "gemini_source", "title": "Directorio", "domain": "directorio.co", "url": "https:\\/\\/directorio.co\\/dentistas" }
                        ] },
                        { "type": "gemini_images", "items": [] }
                    ]
                }
            ]
        }
    ]
}`);

describe("parseGemini", () => {
  test("the recorded Live answer parses with its model and markdown", () => {
    const a = parseGemini(recorded("gemini-live.json"));
    expect(EngineAnswer.parse(a)).toEqual(a);
    expect(a).toMatchObject({
      parserVersion: `gemini@${PARSER_VERSIONS.gemini}`,
      engine: "gemini",
      channel: "ui-vendor",
      provider: "dataforseo",
      modelReported: "3.5 Flash-Lite",
      present: true,
      sources: [],
    });
    expect(a.markdown.startsWith("Albert Einstein (1879–1955) was a German-born")).toBe(true);
  });

  test("the recorded task_get answer parses the same way", () => {
    const a = parseGemini(recorded("gemini-task-get.json"));
    expect(EngineAnswer.parse(a)).toEqual(a);
    expect(a.modelReported).toEqual(expect.any(String));
    expect(a.markdown.length).toBeGreaterThan(0);
  });

  test("Gemini never invents search queries", () => {
    expect(parseGemini(recorded("gemini-live.json")).searchQueries).toBe("unavailable");
    expect(parseGemini(WITH_SOURCES).searchQueries).toBe("unavailable");
  });

  test("reported fan-out queries are kept when the payload carries them", () => {
    const body = new TextDecoder()
      .decode(WITH_SOURCES)
      .replace(
        '"model": "3.5 Flash",',
        '"model": "3.5 Flash", "fan_out_queries": ["odontólogo medellín"],',
      );
    expect(parseGemini(new TextEncoder().encode(body)).searchQueries).toEqual([
      "odontólogo medellín",
    ]);
  });

  test("answer and inline sources are cited once each, redirects kept as returned", () => {
    const a = parseGemini(WITH_SOURCES);
    expect(EngineAnswer.parse(a)).toEqual(a);
    expect(a.markdown).toBe("La Clínica Dental Ejemplo atiende en El Poblado.");
    expect(a.sources).toEqual([
      { url: REDIRECT, domain: "clinicaejemplo.co", title: "Clínica Dental Ejemplo", cited: true },
      { url: "https://odontologos.co/medellin", domain: "odontologos.co", cited: true },
      {
        url: "https://directorio.co/dentistas",
        domain: "directorio.co",
        title: "Directorio",
        cited: true,
      },
    ]);
  });

  test("parsing is pure: the same bytes give the same answer and stay untouched", () => {
    const bytes = recorded("gemini-live.json");
    const copy = bytes.slice();
    expect(parseGemini(bytes)).toEqual(parseGemini(bytes));
    expect(Buffer.from(bytes).equals(Buffer.from(copy))).toBe(true);
  });
});
