import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { EngineAnswer, PARSER_VERSIONS } from "../../../src/answer";
import { CHATGPT_BRIGHTDATA_PARSER, parseChatGpt } from "../../../src/brightdata/parse/chatgpt";

// Real snapshot downloads, gzipped because each carries megabytes of the page's HTML.
const recorded = (name: string): Record<string, unknown> => {
  const gz = readFileSync(new URL(`../../fixtures/recorded/brightdata/${name}`, import.meta.url));
  const records = JSON.parse(gunzipSync(gz).toString("utf8")) as Record<string, unknown>[];
  const [record] = records;
  if (record === undefined) throw new Error(`${name} holds no record`);
  return record;
};

const PEREIRA = recorded("chatgpt-colchon-pereira.json.gz");
const NATIONAL = recorded("chatgpt-banco-digital-colombia.json.gz");

describe("parseChatGpt (Bright Data)", () => {
  test.each([
    ["local, asked from Pereira's centroid", PEREIRA],
    ["national", NATIONAL],
  ])("the recorded %s answer is a valid engine answer", (_, record) => {
    const a = parseChatGpt(record);
    expect(EngineAnswer.parse(a)).toEqual(a);
    expect(a).toMatchObject({
      parserVersion: `chatgpt-brightdata@${PARSER_VERSIONS["chatgpt-brightdata"]}`,
      engine: "chatgpt",
      channel: "ui-vendor",
      provider: "brightdata",
      present: true,
      // The scraper reported neither in these answers; a parser never makes them up.
      modelReported: null,
      searchQueries: "unavailable",
    });
    expect(a.markdown).toBe(record.answer_text_markdown);
    expect(a.sources.length).toBeGreaterThan(0);
    expect(new Set(a.sources.map((s) => s.url)).size).toBe(a.sources.length);
  });

  test("the parser name matches the version stored with each capture", () => {
    expect(CHATGPT_BRIGHTDATA_PARSER).toEqual({
      name: "chatgpt-brightdata@1",
      version: PARSER_VERSIONS["chatgpt-brightdata"],
    });
  });

  test("cited sources keep their order and a hostname, then the retrieved ones", () => {
    const a = parseChatGpt(NATIONAL);
    expect(a.sources[0]).toEqual({
      url: "https://www.superfinanciera.gov.co/Superfinanciera-Tasas/faces/generic/passiveInterestRates.xhtml?utm_source=chatgpt.com",
      domain: "www.superfinanciera.gov.co",
      title: "::Proyecto Tasas de Interes:: Superintendencia Financiera de Colombia.",
      cited: true,
    });
    const retrieved = { url: "https://example.co/otra", title: "Otra", rank: 9 };
    const b = parseChatGpt({ ...NATIONAL, search_sources_more: [retrieved] });
    expect(b.sources.at(-1)).toEqual({
      url: retrieved.url,
      domain: "example.co",
      title: "Otra",
      cited: false,
    });
  });

  test("local businesses come from the map card, with address, site and rating", () => {
    const a = parseChatGpt(PEREIRA);
    expect(a.localBusinesses?.[0]).toEqual({
      name: "Colchones Super S.A.S.",
      url: "http://www.colchonessuper.com/",
      address: "Frente al Sena, Cra. 8 #26-38 Loc - 3, Pereira, Risaralda, Colombia",
      rating: 4.9,
    });
    expect(new Set(a.localBusinesses?.map((b) => b.name)).size).toBe(a.localBusinesses?.length);
    expect(parseChatGpt(NATIONAL).localBusinesses).toEqual([]);
  });

  test("products are kept as returned only when the shopping panel showed", () => {
    expect(parseChatGpt(PEREIRA).products).toEqual(PEREIRA.shopping);
    expect(parseChatGpt({ ...PEREIRA, shopping_visible: false }).products).toEqual([]);
  });

  test("reported model and search queries are kept", () => {
    const a = parseChatGpt({ ...NATIONAL, model: "gpt-6", web_search_query: ["nu colombia"] });
    expect(a).toMatchObject({ modelReported: "gpt-6", searchQueries: ["nu colombia"] });
  });

  test("an empty answer is present: false, not an empty recommendation list", () => {
    const a = parseChatGpt({ ...NATIONAL, answer_text: "", answer_text_markdown: "" });
    expect(a).toMatchObject({ present: false, markdown: "" });
  });

  test("schema drift fails the parse naming the field", () => {
    expect(() => parseChatGpt({ ...NATIONAL, citations: "none" })).toThrow(/citations/);
  });
});
