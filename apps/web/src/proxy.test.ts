import { existsSync } from "node:fs";
import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { CURRENCIES } from "./lib/pricing";
import { config, proxy } from "./proxy";

const rewriteOf = (country?: string, path = "/") => {
  const headers = new Headers(country ? { "x-vercel-ip-country": country } : {});
  const response = proxy(new NextRequest(`https://reranker.co${path}`, { headers }));
  return response.headers.get("x-middleware-rewrite");
};

describe("proxy", () => {
  test.each([
    ["CO", "/home/cop"],
    ["ES", "/home/eur"],
    ["DE", "/home/eur"],
    ["MX", "/home/usd"],
    ["US", "/home/usd"],
  ])("rewrites a visitor from %s to %s", (country, path) => {
    expect(rewriteOf(country)).toBe(`https://reranker.co${path}`);
  });

  test("falls back to USD when the country header is missing", () => {
    expect(rewriteOf()).toBe("https://reranker.co/home/usd");
  });

  test("keeps the query string so campaign links survive the rewrite", () => {
    expect(rewriteOf("CO", "/?utm_source=instagram")).toBe(
      "https://reranker.co/home/cop?utm_source=instagram",
    );
  });

  test.each(CURRENCIES)("the %s rewrite target is a prerendered page", (currency) => {
    expect(existsSync(new URL(`./app/home/${currency}/page.tsx`, import.meta.url))).toBe(true);
  });

  test("only runs on the home page", () => {
    expect(config.matcher).toBe("/");
  });
});
