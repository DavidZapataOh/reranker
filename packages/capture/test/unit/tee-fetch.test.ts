import { resetAppEnv } from "@reranker/env";
import { server } from "@reranker/testing/msw";
import { AiOptimizationGeminiLlmScraperLiveAdvancedRequestInfo } from "dataforseo-client";
import { HttpResponse, http } from "msw";
import { delay } from "msw/utils/delay";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createDataForSeo } from "../../src/dataforseo/client";
import { RawSink } from "../../src/raw/raw-sink";
import { recordingFetch, teeFetch } from "../../src/raw/tee-fetch";

const LOGIN = "capture-unit@example.com";
const PASSWORD = "capture-unit-password";
const TOKEN = Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64");
const GEMINI_LIVE = "*/v3/ai_optimization/gemini/llm_scraper/live/advanced";

// Spacing, key order and escaped slashes as the sandbox prints them: a re-serialized body would differ.
const WIRE = new TextEncoder().encode(
  `{\n    "version": "0.1.20261117",\n    "status_code": 20000,\n    "status_message": "Ok.",\n    "cost": 0.004,\n    "tasks": [\n        {\n            "id": "11181400-1535-0558-0000-6b0e2a1b2c3d",\n            "status_code": 20000,\n            "data": { "tag": "msr_01:0" },\n            "result": [ { "model": "Fast", "markdown": "Cl\\u00ednica en https:\\/\\/example.co" } ]\n        }\n    ]\n}`,
);

const request = new AiOptimizationGeminiLlmScraperLiveAdvancedRequestInfo({
  keyword: "mejor odontólogo en Medellín",
  location_code: 2170,
  language_code: "es",
  tag: "msr_01:0",
});

function serveGemini(body: Uint8Array) {
  const seen: { url: string; authorization: string | null }[] = [];
  server.use(
    http.post(GEMINI_LIVE, ({ request: req }) => {
      seen.push({ url: req.url, authorization: req.headers.get("authorization") });
      return new HttpResponse(body, { headers: { "content-type": "application/json" } });
    }),
  );
  return seen;
}

beforeAll(() => server.listen());
beforeEach(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("DATAFORSEO_LOGIN", LOGIN);
  vi.stubEnv("DATAFORSEO_PASSWORD", PASSWORD);
  resetAppEnv();
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetAppEnv();
});
afterAll(() => server.close());

test("the sink holds the exact wire bytes and the client still parses", async () => {
  const body = WIRE;
  serveGemini(body);
  const sink = new RawSink();
  const { ai } = createDataForSeo(sink, { base: "sandbox" });
  const res = await ai.geminiLlmScraperLiveAdvanced([request]);
  expect(Buffer.from(sink.response ?? []).equals(Buffer.from(body))).toBe(true);
  expect(Buffer.from(JSON.stringify(res)).equals(Buffer.from(body))).toBe(false);
  expect(JSON.parse(Buffer.from(sink.request ?? []).toString())).toEqual([
    expect.objectContaining({ keyword: request.keyword }),
  ]);
  expect(sink).toMatchObject({ status: 200, contentType: "application/json", calls: 1 });
  expect(res?.status_code).toBe(20000);
});

test("basic auth header is sent and never logged", async () => {
  const seen = serveGemini(WIRE);
  const log = vi.spyOn(console, "log");
  const error = vi.spyOn(console, "error");
  const sink = new RawSink();
  await createDataForSeo(sink, { base: "sandbox" }).ai.geminiLlmScraperLiveAdvanced([request]);
  expect(seen[0]?.authorization).toBe(`Basic ${TOKEN}`);
  expect(Buffer.from(sink.request ?? []).toString()).not.toContain(TOKEN);
  expect([...(sink.headers?.values() ?? [])].join()).not.toContain(TOKEN);
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

test("missing credentials fail before any call, naming only the variables", () => {
  vi.stubEnv("DATAFORSEO_PASSWORD", "");
  expect(() => createDataForSeo(new RawSink(), { base: "sandbox" })).toThrowError(
    /DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD/,
  );
});

test("a call past the timeout aborts with a TimeoutError", async () => {
  server.use(
    http.post(GEMINI_LIVE, async () => {
      await delay(200);
      return HttpResponse.json({});
    }),
  );
  const sink = new RawSink();
  const { ai } = createDataForSeo(sink, { base: "sandbox", timeoutMs: 50 });
  await expect(ai.geminiLlmScraperLiveAdvanced([request])).rejects.toMatchObject({
    name: "TimeoutError",
  });
  expect(sink.request).not.toBeNull();
  expect(sink.response).toBeNull();
});

test.each([
  ["production", "https://api.dataforseo.com/"],
  ["preview", "https://sandbox.dataforseo.com/"],
  ["development", "https://sandbox.dataforseo.com/"],
] as const)("base url follows APP_ENV %s", async (env, base) => {
  vi.stubEnv("APP_ENV", env);
  resetAppEnv();
  const seen = serveGemini(WIRE);
  await createDataForSeo(new RawSink()).ai.geminiLlmScraperLiveAdvanced([request]);
  expect(seen[0]?.url).toBe(`${base}v3/ai_optimization/gemini/llm_scraper/live/advanced`);
});

test("an explicit base wins over APP_ENV", async () => {
  vi.stubEnv("APP_ENV", "production");
  resetAppEnv();
  const seen = serveGemini(WIRE);
  await createDataForSeo(new RawSink(), { base: "sandbox" }).ai.geminiLlmScraperLiveAdvanced([
    request,
  ]);
  expect(seen[0]?.url).toMatch(/^https:\/\/sandbox\.dataforseo\.com\//);
});

test("each call starts clean, so a failed call never shows the previous response", async () => {
  const url = "https://provider.test/v1/answer";
  let fail = false;
  server.use(
    http.post(url, () => (fail ? HttpResponse.error() : HttpResponse.text("first answer"))),
  );
  const sink = new RawSink();
  const tee = recordingFetch(sink);
  await tee(url, { method: "POST", body: "one" });
  fail = true;
  await expect(tee(url, { method: "POST", body: "two" })).rejects.toThrow();
  expect(sink).toMatchObject({ calls: 2, response: null, status: null, headers: null });
  expect(Buffer.from(sink.request ?? []).toString()).toBe("two");
});

test("a non-200 response keeps its status, headers and bytes", async () => {
  const url = "https://provider.test/v1/answer";
  const html = "<html><body>502 Bad Gateway</body></html>";
  server.use(
    http.get(
      url,
      () => new HttpResponse(html, { status: 502, headers: { "content-type": "text/html" } }),
    ),
  );
  const sink = new RawSink();
  const res = await recordingFetch(sink, { headers: { "x-api-key": "k" } })(url);
  expect(res.status).toBe(502);
  expect(await res.text()).toBe(html);
  expect(sink).toMatchObject({ status: 502, contentType: "text/html", request: null });
  expect(Buffer.from(sink.response ?? []).toString()).toBe(html);
});

test("binary and Request bodies are recorded byte for byte", async () => {
  const url = "https://provider.test/v1/answer";
  const seen: string[] = [];
  server.use(
    http.post(url, async ({ request: req }) => {
      seen.push(await req.text());
      return HttpResponse.text("ok");
    }),
  );
  const sink = new RawSink();
  const tee = recordingFetch(sink);
  const bytes = new TextEncoder().encode("xxbinaryxx").subarray(2, 8);
  await tee(url, { method: "POST", body: bytes });
  expect(Buffer.from(sink.request ?? []).toString()).toBe("binary");
  await tee(url, { method: "POST", body: new TextEncoder().encode("buffer").buffer });
  expect(Buffer.from(sink.request ?? []).toString()).toBe("buffer");
  await tee(new Request(url, { method: "POST", body: "from request" }));
  expect(Buffer.from(sink.request ?? []).toString()).toBe("from request");
  expect(seen).toEqual(["binary", "buffer", "from request"]);
});

test("a body that cannot be copied byte for byte is refused before the call", async () => {
  const sink = new RawSink();
  await expect(
    recordingFetch(sink)("https://provider.test/v1/answer", {
      method: "POST",
      body: new URLSearchParams({ a: "b" }),
    }),
  ).rejects.toThrow(TypeError);
  expect(sink.calls).toBe(0);
});

test("the caller's abort signal still cancels the call", async () => {
  const url = "https://provider.test/v1/slow";
  server.use(
    http.get(url, async () => {
      await delay(200);
      return HttpResponse.text("late");
    }),
  );
  const controller = new AbortController();
  const call = teeFetch({ login: LOGIN, password: PASSWORD }, new RawSink())(url, {
    signal: controller.signal,
  });
  controller.abort();
  await expect(call).rejects.toMatchObject({ name: "AbortError" });
});
