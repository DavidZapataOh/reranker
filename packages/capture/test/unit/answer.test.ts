import { describe, expect, test } from "vitest";
import { EngineAnswer, PARSER_VERSIONS, safeParseAnswer } from "../../src/answer";

const answer: EngineAnswer = {
  parserVersion: "gemini@1",
  engine: "gemini",
  channel: "ui-vendor",
  provider: "dataforseo",
  modelReported: "Fast",
  present: true,
  markdown: "La mejor opción en Medellín es **Clínica Ejemplo**.",
  sources: [
    {
      url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc",
      domain: "vertexaisearch.cloud.google.com",
      title: "Clínica Ejemplo",
      cited: true,
      resolvedUrl: "https://clinicaejemplo.co/",
    },
  ],
  searchQueries: "unavailable",
};

const bytes = new TextEncoder().encode("{}");

describe("EngineAnswer", () => {
  test("accepts a complete answer and an absent surface", () => {
    expect(EngineAnswer.parse(answer)).toEqual(answer);
    const absent = { ...answer, present: false, markdown: "", sources: [], modelReported: null };
    expect(EngineAnswer.safeParse(absent).success).toBe(true);
  });

  test("rejects the prompt as a search query placeholder", () => {
    expect(EngineAnswer.safeParse({ ...answer, searchQueries: "n/a" }).success).toBe(false);
    expect(EngineAnswer.safeParse({ ...answer, searchQueries: [""] }).success).toBe(false);
    expect(
      EngineAnswer.safeParse({ ...answer, searchQueries: ["clínicas medellín"] }).success,
    ).toBe(true);
  });

  test("requires a versioned parser name and rejects unknown fields", () => {
    expect(EngineAnswer.safeParse({ ...answer, parserVersion: "gemini" }).success).toBe(false);
    expect(EngineAnswer.safeParse({ ...answer, parserVersion: "gemini@0" }).success).toBe(false);
    expect(EngineAnswer.safeParse({ ...answer, extra: 1 }).success).toBe(false);
  });

  test("keeps the provider metadata the control channel reports", () => {
    const meta = { requestId: "req_1", processingMs: 812, searches: 2, modelRequested: "gpt-5" };
    expect(EngineAnswer.parse({ ...answer, meta }).meta).toEqual(meta);
    expect(EngineAnswer.safeParse({ ...answer, meta: { searches: -1 } }).success).toBe(false);
  });

  test("every parser starts at version 1", () => {
    expect(PARSER_VERSIONS).toEqual({
      chatgpt: 1,
      "chatgpt-brightdata": 1,
      gemini: 1,
      "google-ai-overview": 1,
      "google-ai-mode": 1,
    });
  });
});

describe("safeParseAnswer", () => {
  test("returns the parsed answer", () => {
    expect(safeParseAnswer(() => answer, bytes)).toEqual({ answer, error: null });
  });

  test("turns a throwing parser into an error without throwing", () => {
    const result = safeParseAnswer(() => JSON.parse("<html>502</html>"), bytes);
    expect(result.answer).toBeNull();
    expect(result.error).toMatch(/^SyntaxError: /);
  });

  test("rejects what a parser returns when it breaks the schema", () => {
    const broken = () => ({ ...answer, searchQueries: "n/a" }) as unknown as EngineAnswer;
    const result = safeParseAnswer(broken, bytes);
    expect(result.answer).toBeNull();
    expect(result.error).toMatch(/searchQueries/);
  });

  test("reports a non-Error throw", () => {
    const result = safeParseAnswer(() => {
      throw "boom";
    }, bytes);
    expect(result).toEqual({ answer: null, error: "boom" });
  });
});
