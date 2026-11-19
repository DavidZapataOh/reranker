import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { delay } from "msw/utils/delay";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type { EngineAnswer } from "../../src/answer";
import { resolveRedirects } from "../../src/resolve-redirects";

const PREFIX = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function answer(urls: string[]): EngineAnswer {
  return {
    parserVersion: "gemini@1",
    engine: "gemini",
    channel: "ui-vendor",
    provider: "dataforseo",
    modelReported: "3.5 Flash",
    present: true,
    markdown: "",
    sources: urls.map((url) => ({ url, domain: new URL(url).hostname, cited: true })),
    searchQueries: "unavailable",
  };
}

const redirectTo = (target: (id: string) => string | null) =>
  http.get(`${PREFIX}:id`, ({ params }) => {
    const location = target(String(params.id));
    return location === null
      ? new HttpResponse(null, { status: 404 })
      : new HttpResponse(null, { status: 302, headers: { location } });
  });

describe("resolveRedirects", () => {
  test("reads Location without following it and keeps the returned url", async () => {
    server.use(redirectTo(() => "https://clinica.co/"));
    // Following the redirect would hit this unhandled host and fail the test.
    const input = answer([`${PREFIX}abc`, "https://odontologos.co/medellin"]);
    const out = await resolveRedirects(input);
    expect(out.sources[0]).toEqual({ ...input.sources[0], resolvedUrl: "https://clinica.co/" });
    expect(out.sources[1]).toEqual(input.sources[1]);
    expect(input.sources[0]).not.toHaveProperty("resolvedUrl");
  });

  test("a relative Location resolves against the redirect url", async () => {
    server.use(redirectTo(() => "/elsewhere"));
    const out = await resolveRedirects(answer([`${PREFIX}abc`]));
    expect(out.sources[0]?.resolvedUrl).toBe("https://vertexaisearch.cloud.google.com/elsewhere");
  });

  test("a slow redirect is dropped after the timeout", async () => {
    server.use(
      http.get(`${PREFIX}:id`, async () => {
        await delay(500);
        return new HttpResponse(null, { status: 302, headers: { location: "https://late.co/" } });
      }),
    );
    const started = performance.now();
    const out = await resolveRedirects(answer([`${PREFIX}slow`]), { timeoutMs: 50 });
    expect(out.sources[0]).not.toHaveProperty("resolvedUrl");
    expect(performance.now() - started).toBeLessThan(400);
  });

  test("a failed or non-redirect answer leaves resolvedUrl absent", async () => {
    server.use(
      http.get(`${PREFIX}down`, () => HttpResponse.error()),
      http.get(`${PREFIX}page`, () => new HttpResponse("<html></html>", { status: 200 })),
      redirectTo((id) => (id === "gone" ? null : "https://ok.co/")),
    );
    const out = await resolveRedirects(
      answer([`${PREFIX}gone`, `${PREFIX}down`, `${PREFIX}page`, `${PREFIX}fine`]),
    );
    expect(out.sources.map((s) => s.resolvedUrl)).toEqual([
      undefined,
      undefined,
      undefined,
      "https://ok.co/",
    ]);
  });

  test("never more than `concurrency` requests in flight, and each url fetched once", async () => {
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    server.use(
      http.get(`${PREFIX}:id`, async ({ params }) => {
        calls += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await delay(20);
        inFlight -= 1;
        return new HttpResponse(null, {
          status: 302,
          headers: { location: `https://site.co/${String(params.id)}` },
        });
      }),
    );
    const urls = Array.from({ length: 8 }, (_, i) => `${PREFIX}${i}`);
    const out = await resolveRedirects(answer([...urls, urls[0] as string]), { concurrency: 3 });
    expect(peak).toBe(3);
    expect(calls).toBe(8);
    expect(out.sources.at(-1)?.resolvedUrl).toBe("https://site.co/0");
  });

  test("an answer without grounding redirects makes no request", async () => {
    // Any request would be unhandled and fail the test.
    const input = answer(["https://example.co/", "https://vertexaisearch.cloud.google.com/other"]);
    expect(await resolveRedirects(input)).toEqual(input);
  });
});
