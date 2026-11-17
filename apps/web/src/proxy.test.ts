import { existsSync } from "node:fs";
import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { CURRENCIES } from "./lib/pricing";
import { config, proxy } from "./proxy";

const rewriteOf = (country?: string, path = "/") => {
  const headers = new Headers(country ? { "x-vercel-ip-country": country } : {});
  const response = proxy(new NextRequest(`https://reranker.co${path}`, { headers }));
  return response?.headers.get("x-middleware-rewrite");
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
});

describe("proxy on /app", () => {
  const appRequest = (cookie?: string) =>
    new NextRequest("https://reranker.co/app/x/cuenta?tab=1", {
      headers: cookie ? { cookie } : {},
    });

  test("redirects /app without a session cookie to /ingresar with volver", () => {
    const response = proxy(new NextRequest("https://reranker.co/app/x/cuenta"));
    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toBe(
      "https://reranker.co/ingresar?volver=%2Fapp%2Fx%2Fcuenta",
    );
  });

  test("keeps the query string in volver", () => {
    expect(proxy(appRequest())?.headers.get("location")).toBe(
      "https://reranker.co/ingresar?volver=%2Fapp%2Fx%2Fcuenta%3Ftab%3D1",
    );
  });

  test("lets /app through when rr.session_token exists", () => {
    expect(proxy(appRequest("rr.session_token=abc"))).toBeUndefined();
  });

  test("recognises the secure cookie name in production", () => {
    expect(proxy(appRequest("__Secure-rr.session_token=abc"))).toBeUndefined();
  });

  test("ignores a session cookie with another prefix", () => {
    expect(proxy(appRequest("better-auth.session_token=abc"))?.headers.get("location")).toMatch(
      /\/ingresar\?volver=/,
    );
  });
});

test("runs only on the home page and under /app", () => {
  expect(config.matcher).toEqual(["/", "/app/:path*"]);
});
