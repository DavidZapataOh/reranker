import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { EngineAnswer, PARSER_VERSIONS } from "../../src/answer";
import { OPENAI_RESPONSES_PARSER, parseOpenAIResponse } from "../../src/openai/parse";

const RECORDED = new URL("../fixtures/recorded/openai/", import.meta.url);
const bytes = new Uint8Array(readFileSync(new URL("control-medellin.json", RECORDED)));
const headers = new Headers(
  JSON.parse(readFileSync(new URL("control-medellin.headers.json", RECORDED), "utf8")),
);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

test("recorded response parses with sources, cited flags, queries and meta", () => {
  const a = parseOpenAIResponse(bytes, headers, "gpt-6.1-terra");
  expect(EngineAnswer.parse(a)).toEqual(a);
  expect(a).toMatchObject({
    parserVersion: "openai-responses@1",
    engine: "chatgpt",
    channel: "api",
    provider: "openai",
    modelReported: "gpt-6.1-terra",
    present: true,
    meta: {
      requestId: "req_59d87be791ba484b9932658b62c66a5a",
      processingMs: 10399,
      responseId: "resp_01a577405ba9400c016b007f4ccde487d1b26f10b384a27dc9",
      searches: 1,
      modelRequested: "gpt-6.1-terra",
    },
  });
  expect(a.markdown.length).toBeGreaterThan(0);
  expect(a.searchQueries).toHaveLength(2);
  expect(a.sources.some((s) => s.cited)).toBe(true);
  expect(a.sources.some((s) => !s.cited)).toBe(true);
});

test("a citation marks the searched source it points to, despite the utm tag OpenAI adds", () => {
  const a = parseOpenAIResponse(bytes, headers, "gpt-6.1-terra");
  expect(a.sources.find((s) => s.url === "https://www.doctoralia.co/odontologo/medellin")).toEqual({
    url: "https://www.doctoralia.co/odontologo/medellin",
    domain: "www.doctoralia.co",
    title: "Los 20 Odontólogos más recomendados en Medellín - Doctoralia",
    cited: true,
  });
  expect(new Set(a.sources.map((s) => s.url)).size).toBe(a.sources.length);
});

const response = (output: unknown[], extra: Record<string, unknown> = {}) =>
  encode({ id: "resp_1", object: "response", status: "completed", model: "m", output, ...extra });

test("a cited URL the search did not list is kept as a cited source", () => {
  const a = parseOpenAIResponse(
    response([
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "Hola",
            annotations: [
              { type: "url_citation", url: "https://a.co/x?utm_source=openai&k=1", title: "A" },
            ],
          },
        ],
      },
    ]),
    new Headers(),
    "m",
  );
  expect(a.sources).toEqual([
    { url: "https://a.co/x?k=1", domain: "a.co", title: "A", cited: true },
  ]);
  expect(a.searchQueries).toEqual([]);
  expect(a.meta).toEqual({ responseId: "resp_1", searches: 0, modelRequested: "m" });
});

test("only search actions count as searches and give queries", () => {
  const a = parseOpenAIResponse(
    response([
      { type: "web_search_call", action: { type: "search", queries: ["q1", "q2"], query: "q1" } },
      { type: "web_search_call", action: { type: "open_page", url: "https://b.co" } },
      { type: "web_search_call", action: { type: "search", query: "old" } },
    ]),
    new Headers(),
    "m",
  );
  expect(a.meta?.searches).toBe(2);
  expect(a.searchQueries).toEqual(["q1", "q2"]);
  expect(a.present).toBe(false);
  expect(a.markdown).toBe("");
});

test("a link that is not a URL is kept as given, with no domain", () => {
  const a = parseOpenAIResponse(
    response([
      {
        type: "web_search_call",
        action: { type: "search", sources: [{ type: "url", url: "x y" }] },
      },
    ]),
    new Headers({ "x-request-id": "req_1", "openai-processing-ms": "fast" }),
    "m",
  );
  expect(a.sources).toEqual([{ url: "x y", domain: "", cited: false }]);
  expect(a.meta).toEqual({
    requestId: "req_1",
    responseId: "resp_1",
    searches: 1,
    modelRequested: "m",
  });
});

test("the parser name matches the version stored with each capture", () =>
  expect(OPENAI_RESPONSES_PARSER).toEqual({
    name: "openai-responses@1",
    version: PARSER_VERSIONS["openai-responses"],
  }));

test("a body that is not a response is refused", () => {
  expect(() => parseOpenAIResponse(encode({ error: { code: "x" } }), new Headers(), "m")).toThrow();
  expect(() => parseOpenAIResponse(new TextEncoder().encode("{"), new Headers(), "m")).toThrow();
});
