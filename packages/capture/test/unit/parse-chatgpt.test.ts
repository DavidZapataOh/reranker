import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { EngineAnswer, PARSER_VERSIONS } from "../../src/answer";
import { parseChatGpt } from "../../src/dataforseo/parse/chatgpt";

const recorded = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/recorded/sandbox/${name}`, import.meta.url)));

// The sandbox recordings carry no local businesses, products or empty answers, so these bodies
// follow the documented example, printed the way the sandbox prints (four spaces, escaped slashes).
const wire = (result: string) =>
  new TextEncoder().encode(
    `{\n    "status_code": 20000,\n    "tasks": [\n        {\n            "id": "11190445-3192-0629-2000-5b418c45e758",\n            "status_code": 20000,\n            "result": [\n                ${result}\n            ]\n        }\n    ]\n}`,
  );

const LOCAL_AND_PRODUCTS = wire(`{
    "model": "gpt-6",
    "markdown": "**[La Casa Del Caffe](http:\\/\\/www.lacasadelcaffe.com?utm_source=chatgpt.com)**",
    "sources": null,
    "search_results": null,
    "fan_out_queries": null,
    "brand_entities": [
        { "type": "chat_gpt_brand_entity", "title": "Coffee shop chain", "category": "business", "markdown": "La Casa Del Caffe", "urls": [ { "url": "http:\\/\\/www.lacasadelcaffe.com", "domain": "www.lacasadelcaffe.com" } ] }
    ],
    "items": [
        { "type": "chat_gpt_local_businesses", "rank_group": 1, "rank_absolute": 1, "markdown": "**La Casa Del Caffe**", "items": [
            { "type": "chat_gpt_local_businesses_element", "title": "La Casa Del Caffe", "address": "1036 Morris Park Ave, Bronx, NY 10461", "phone": "+17189317816", "reviews_count": 22, "url": "http:\\/\\/www.lacasadelcaffe.com?utm_source=chatgpt.com", "domain": "www.lacasadelcaffe.com", "rating": { "rating_type": "Max5", "value": 3.9, "votes_count": 22, "rating_max": 5 } },
            { "type": "chat_gpt_local_businesses_element", "title": "Boogie Down Grind", "address": null, "url": null, "rating": null },
            { "type": "chat_gpt_local_businesses_element", "title": null }
        ] },
        { "type": "chat_gpt_products", "rank_group": 1, "rank_absolute": 2, "items": [
            { "type": "chat_gpt_products_element", "product_id": "gid:\\/\\/shopify\\/p\\/7JnWm9ccvIQ5SklKKTC9zt", "title": "Espresso", "price": 12.5, "currency": "USD" }
        ] }
    ]
}`);

describe("parseChatGpt", () => {
  test("the recorded Live answer parses with its fan-out, model and brand entities", () => {
    const a = parseChatGpt(recorded("chatgpt-live.json"));
    expect(EngineAnswer.parse(a)).toEqual(a);
    expect(a).toMatchObject({
      parserVersion: `chatgpt@${PARSER_VERSIONS.chatgpt}`,
      engine: "chatgpt",
      channel: "ui-vendor",
      provider: "dataforseo",
      modelReported: "gpt-6",
      present: true,
      searchQueries: [
        "Albert Einstein biography life work theory of relativity Nobel Prize reliable sources",
      ],
      // ChatGPT names the entity in `markdown` and puts its disambiguation in `title`.
      brandEntities: [{ name: "Albert Einstein", category: "people", urls: [] }],
      localBusinesses: [],
      products: [],
    });
    expect(a.markdown.startsWith("# Albert Einstein \\(1879–1955)\n![File:Albert Einstein")).toBe(
      true,
    );
  });

  test("cited sources come first and every other search result is kept as not cited", () => {
    const a = parseChatGpt(recorded("chatgpt-live.json"));
    const cited = a.sources.filter((s) => s.cited);
    expect(cited).toHaveLength(5);
    expect(a.sources.slice(0, 5)).toEqual(cited);
    expect(a.sources).toHaveLength(12);
    expect(new Set(a.sources.map((s) => s.url)).size).toBe(12);
    expect(cited[0]).toEqual({
      url: "https://www.history.com/articles/albert-einstein?utm_source=chatgpt.com",
      domain: "www.history.com",
      title: "Albert Einstein",
      cited: true,
    });
    expect(a.sources).toContainEqual({
      url: "https://www.pbs.org/wnet/americanmasters/albert-einstein-how-i-see-the-world/585/?utm_source=chatgpt.com",
      domain: "www.pbs.org",
      title: "Albert Einstein's biography | American Masters | PBS",
      cited: false,
    });
  });

  test("a task_get answer parses the same way, including a cited source never searched", () => {
    const a = parseChatGpt(recorded("chatgpt-task-get.json"));
    expect(EngineAnswer.parse(a)).toEqual(a);
    expect(a.sources.filter((s) => s.cited)).toHaveLength(7);
    expect(a.sources).toHaveLength(13);
    expect(a.brandEntities).toEqual([]);
    expect(a.searchQueries).toEqual([
      "Albert Einstein biography scientific contributions Nobel Prize reliable sources",
    ]);
  });

  test("local businesses, products and brand URLs come from their elements", () => {
    const a = parseChatGpt(LOCAL_AND_PRODUCTS);
    expect(EngineAnswer.parse(a)).toEqual(a);
    expect(a.localBusinesses).toEqual([
      {
        name: "La Casa Del Caffe",
        url: "http://www.lacasadelcaffe.com?utm_source=chatgpt.com",
        address: "1036 Morris Park Ave, Bronx, NY 10461",
        rating: 3.9,
      },
      { name: "Boogie Down Grind" },
    ]);
    expect(a.products).toEqual([
      {
        type: "chat_gpt_products_element",
        product_id: "gid://shopify/p/7JnWm9ccvIQ5SklKKTC9zt",
        title: "Espresso",
        price: 12.5,
        currency: "USD",
      },
    ]);
    expect(a.brandEntities).toEqual([
      { name: "La Casa Del Caffe", category: "business", urls: ["http://www.lacasadelcaffe.com"] },
    ]);
  });

  test("an answer without sources or fan-out has empty lists, never the prompt", () => {
    const a = parseChatGpt(LOCAL_AND_PRODUCTS);
    expect(a.sources).toEqual([]);
    expect(a.searchQueries).toEqual([]);
  });

  test("a body without a result is an error for the caller to record", () => {
    expect(() =>
      parseChatGpt(new TextEncoder().encode('{"status_code":20000,"tasks":[{"result":null}]}')),
    ).toThrow(/no result/);
    expect(() => parseChatGpt(new TextEncoder().encode("<html>502</html>"))).toThrow(SyntaxError);
  });

  test("parsing is pure: the same bytes give the same answer and stay untouched", () => {
    const bytes = recorded("chatgpt-live.json");
    const copy = bytes.slice();
    expect(parseChatGpt(bytes)).toEqual(parseChatGpt(bytes));
    expect(Buffer.from(bytes).equals(Buffer.from(copy))).toBe(true);
  });
});

// Production answers to Spanish local questions, recorded byte for byte.
const live = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/recorded/live/${name}`, import.meta.url)));

describe("parseChatGpt on production answers", () => {
  test("a local question yields its businesses, brands, fan-out and cited pages", () => {
    const a = parseChatGpt(live("chatgpt-colchon-bogota.json"));
    expect(EngineAnswer.parse(a)).toEqual(a);
    expect(a).toMatchObject({ modelReported: "gpt-6", present: true });
    expect(a.searchQueries).toEqual([
      "dónde comprar colchones en Bogotá tiendas direcciones marcas Colombia 2026",
    ]);
    expect(a.localBusinesses).toHaveLength(5);
    expect(a.localBusinesses?.[0]).toEqual({
      name: "Colchones El Dorado CC Multiplaza",
      url: "https://www.colchoneseldorado.com/",
      address: "Avenida Boyaca Calle 19 Local c-146 A, Bogotá, Cundinamarca, Colombia",
      rating: 4.9,
    });
    // A business without a website keeps its name and address.
    expect(a.localBusinesses).toContainEqual({
      name: "Basecamas y colchones El Dormilon Alamos",
      address: "Dg. 63f #88-14, Bogotá, Colombia",
      rating: 4.8,
    });
    expect(a.brandEntities?.[0]).toEqual({
      name: "Colchones El Dorado",
      category: "local_business",
      urls: [],
    });
    expect(a.sources.filter((s) => s.cited).map((s) => s.domain)).toEqual([
      "www.colchoneseldorado.com",
      "americanadecolchones.com",
      "colchonesdormiluna.com",
      "www.sleepgreen.com.co",
      "www.pullman.com.co",
    ]);
  });

  test("an answer that cites nothing keeps what it searched as not cited", () => {
    const a = parseChatGpt(live("chatgpt-dentistas-medellin.json"));
    expect(EngineAnswer.parse(a)).toEqual(a);
    expect(a.sources).toHaveLength(12);
    expect(a.sources.some((s) => s.cited)).toBe(false);
    expect(a.localBusinesses).toHaveLength(7);
    expect(a.brandEntities).toHaveLength(7);
  });

  test.each(["chatgpt-abogado-laboral-cdmx.json", "chatgpt-pico-y-placa-medellin.json"])(
    "%s parses into a valid answer with its fan-out",
    (name) => {
      const a = parseChatGpt(live(name));
      expect(EngineAnswer.parse(a)).toEqual(a);
      expect(a.markdown.length).toBeGreaterThan(0);
      expect(a.searchQueries).not.toEqual("unavailable");
      expect((a.searchQueries as string[]).length).toBeGreaterThan(0);
    },
  );
});
