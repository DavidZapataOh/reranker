import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { EngineId } from "@reranker/schema";
import type { EntityKey } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import {
  type AnswerCitations,
  type CitationCapture,
  citationKeyOf,
  citationStats,
  citationsOf,
  registrableDomain,
  targetKeysOf,
} from "../src/citations";
import { estimateRate } from "../src/rate";

test("the Public Suffix List snapshot is the pinned one the notice names", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const pinned = /^\s+tldts: (\S+)$/m.exec(read("../../../pnpm-workspace.yaml"))?.[1];
  const installed = createRequire(import.meta.url)("tldts/package.json").version;
  expect(installed).toBe(pinned);
  expect(read("../NOTICE")).toContain(`tldts ${pinned} `);
});

describe("registrableDomain", () => {
  test.each([
    ["www.casalola.com.co", "casalola.com.co"],
    ["clinica.example.co.uk", "example.co.uk"],
    ["WWW.Example.COM.", "example.com"],
    // Private PSL rules: each blog is its owner's site.
    ["sonrisas.blogspot.com", "sonrisas.blogspot.com"],
    ["acme.github.io", "acme.github.io"],
    ["192.168.0.1", "192.168.0.1"],
    ["localhost", "localhost"],
  ])("%s → %s", (host, domain) => expect(registrableDomain(host)).toBe(domain));
});

describe("citationKeyOf", () => {
  test.each([
    ["https://www.doctoralia.co/dra-ana", "platform:doctoralia"],
    ["https://es.tripadvisor.com.mx/Restaurant_Review", "platform:tripadvisor"],
    ["https://www.google.com/maps/place/Sonrisas", "platform:google-maps"],
    ["https://www.instagram.com/casalola/", "platform:instagram"],
    ["https://m.facebook.com/casalola", "platform:facebook"],
    ["https://www.google.com/search?q=colchones", "web:google.com"],
    ["https://blog.casalola.com.co/post", "web:casalola.com.co"],
    ["http://xn--caf-dma.com.co/", "web:xn--caf-dma.com.co"],
    ["https://café.com.co/menu", "web:xn--caf-dma.com.co"],
  ])("%s → %s", (url, key) => expect(citationKeyOf(url)).toBe(key));

  test("a link that is not a web page has no key", () => {
    expect(citationKeyOf("mailto:hola@casalola.com.co")).toBeNull();
    expect(citationKeyOf("not a url")).toBeNull();
  });
});

describe("citationsOf", () => {
  const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC";

  test("reads cited sources only, through their resolved redirect", () => {
    const { byKey, unattributed } = citationsOf([
      { url: "https://www.casalola.com.co/", cited: true },
      { url: "https://www.pullman.com.co/", cited: false },
      { url: redirect, resolvedUrl: "https://www.doctoralia.co/x", cited: true },
      { url: "https://google.com/goto?url=CAES", cited: true },
    ]);
    expect(Object.fromEntries(byKey)).toEqual({
      "web:casalola.com.co": 1,
      "platform:doctoralia": 1,
    });
    expect(unattributed).toBe(1);
  });

  test("a page cited twice, with a fragment or campaign tags, counts once", () => {
    const { byKey } = citationsOf(
      [
        { url: "https://casalola.com.co/menu?utm_source=openai", cited: true },
        { url: "https://casalola.com.co/menu#postres", cited: true },
        { url: "https://casalola.com.co/carta?plato=1", cited: true },
      ],
      ["https://casalola.com.co/menu"],
    );
    expect(Object.fromEntries(byKey)).toEqual({ "web:casalola.com.co": 2 });
  });

  test("a mention's link adds to the sources and reuses their resolved redirects", () => {
    const { byKey, unattributed } = citationsOf(
      [{ url: redirect, resolvedUrl: "https://casalola.com.co/", cited: false }],
      [redirect, "https://www.instagram.com/casalola"],
    );
    expect(Object.fromEntries(byKey)).toEqual({
      "web:casalola.com.co": 1,
      "platform:instagram": 1,
    });
    expect(unattributed).toBe(0);
  });
});

test("a platform host is never the business's own site", () => {
  expect([
    ...targetKeysOf(["casalola.com.co", "https://www.casalola.co/", "instagram.com/casalola"]),
  ]).toEqual(["web:casalola.com.co", "web:casalola.co"]);
});

describe("citationStats", () => {
  const cites = (...keys: EntityKey[]): AnswerCitations => ({
    byKey: new Map(keys.map((k) => [k, 1])),
    unattributed: 0,
  });
  // Two engines with one intent each, weighted equally; the second has three answers.
  const captures: CitationCapture[] = [
    ...Array.from({ length: 4 }, () => ({
      engine: "chatgpt" as EngineId,
      stratum: "chatgpt|a",
      weight: 0.5,
      engineWeight: 1,
    })),
    ...Array.from({ length: 3 }, () => ({
      engine: "gemini" as EngineId,
      stratum: "gemini|a",
      weight: 0.5,
      engineWeight: 1,
    })),
  ];
  const answers: AnswerCitations[] = [
    cites("web:casalola.com.co", "platform:doctoralia"),
    cites("platform:doctoralia"),
    cites("platform:doctoralia", "web:rival.com"),
    cites(),
    cites("web:rival.com"),
    cites("web:casalola.com.co"),
    { byKey: new Map([["platform:doctoralia", 4]]), unattributed: 2 },
  ];
  const input = {
    captures,
    answers,
    targetDomains: ["www.casalola.com.co"],
    recommendsTarget: Uint8Array.from([1, 0, 0, 0, 0, 1, 0]),
    recommendsCompetitor: Uint8Array.from([0, 1, 1, 0, 1, 0, 1]),
    topN: 10,
  };
  const stats = citationStats(input);

  test("counts every answer and citation", () => {
    expect(stats).toMatchObject({ answers: 7, answersCiting: 6, citations: 11, unattributed: 2 });
  });

  test("the target's rate is the stratified rate of answers citing its site", () => {
    const expected = estimateRate([
      { stratum: "chatgpt|a", weight: 0.5, successes: 1, trials: 4 },
      { stratum: "gemini|a", weight: 0.5, successes: 1, trials: 3 },
    ]);
    expect(stats.target?.rate).toEqual(expected);
    expect(stats.target?.rate.estimate).toBeCloseTo(0.5 * (1 / 4) + 0.5 * (1 / 3), 12);
    expect(stats.target?.keys).toEqual(["web:casalola.com.co"]);
    expect(stats.target?.byEngine.gemini?.estimate).toBeCloseTo(1 / 3, 12);
  });

  test("the share weighs answers like the rates", () => {
    // chatgpt: 1 own of 5 URLs over 4 answers; gemini: 1 own of 6 URLs over 3 answers.
    const own = 0.5 * (1 / 4) + 0.5 * (1 / 3);
    const all = 0.5 * (5 / 4) + 0.5 * (6 / 3);
    expect(stats.target?.share).toMatchObject({ citations: 2, total: 11 });
    expect(stats.target?.share?.estimate).toBeCloseTo(own / all, 12);
    expect(stats.target?.share?.estimate).not.toBeCloseTo(2 / 11, 3);
  });

  test("top domains rank by weighted rate, each with its interval", () => {
    expect(stats.top.map((d) => [d.key, d.isTarget])).toEqual([
      ["platform:doctoralia", false],
      ["web:casalola.com.co", true],
      ["web:rival.com", false],
    ]);
    expect(stats.top[0]?.rate.estimate).toBeCloseTo(0.5 * (3 / 4) + 0.5 * (1 / 3), 12);
    expect(stats.topByEngine.gemini?.map((d) => d.key)).toEqual([
      "platform:doctoralia",
      "web:casalola.com.co",
      "web:rival.com",
    ]);
    expect(citationStats({ ...input, topN: 1 }).top.map((d) => d.key)).toEqual([
      "platform:doctoralia",
    ]);
  });

  test("competitor-only sources are never cited where the target is recommended", () => {
    // doctoralia backs the target in answer 0, so only rival.com is missing for it.
    expect(stats.competitorOnly.map((d) => d.key)).toEqual(["web:rival.com"]);
    const rate = stats.competitorOnly[0]?.rate;
    expect(rate?.trials).toBe(4);
    expect(rate?.estimate).toBeCloseTo(0.5 * (1 / 2) + 0.5 * (1 / 2), 12);
  });

  test("an engine left out of the headline counts in its own rates only", () => {
    const excluded = captures.map((c) => ({ ...c, weight: c.engine === "gemini" ? 0 : 1 }));
    const s = citationStats({ ...input, captures: excluded });
    expect(s.target?.rate.estimate).toBeCloseTo(1 / 4, 12);
    expect(s.target?.byEngine.gemini?.estimate).toBeCloseTo(1 / 3, 12);
    expect(s.target?.share?.estimate).toBeCloseTo(1 / 5, 12);
  });

  test("a business without a site has no target figures", () => {
    const s = citationStats({ ...input, targetDomains: [] });
    expect(s.target).toBeNull();
    expect(s.top.every((d) => !d.isTarget)).toBe(true);
  });

  test("no answer recommending a competitor leaves no competitor-only source", () => {
    const s = citationStats({ ...input, recommendsCompetitor: new Uint8Array(7) });
    expect(s.competitorOnly).toEqual([]);
  });
});
