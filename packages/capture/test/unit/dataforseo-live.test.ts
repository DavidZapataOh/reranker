import { readFileSync } from "node:fs";
import { geoForEngine, getGeo } from "@reranker/catalog";
import { resetAppEnv } from "@reranker/env";
import { ProviderRejectedError, ProviderUnavailableError, RateLimitedError } from "@reranker/jobs";
import type { EngineId } from "@reranker/schema";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { EngineAnswer } from "../../src/answer";
import { captureLive } from "../../src/dataforseo/live";
import { type DataForSeoOutcome, mapDataForSeoStatus } from "../../src/dataforseo/status";
import { type FrozenSlot, slotId } from "../../src/slot";

const jobs = vi.hoisted(() => ({
  breakerRecord: vi.fn(async (_provider: string, _outcome: "success" | "failure") => {}),
}));

vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  ...jobs,
}));

const GEMINI_LIVE = "*/v3/ai_optimization/gemini/llm_scraper/live/advanced";
const AI_MODE_LIVE = "*/v3/serp/google/ai_mode/live/advanced";
const MEASUREMENT = "0193b6f2-7c1e-7a51-9b3a-5f2e8d4c1a90";

// 40100.bin is the sandbox's answer to a call without credentials (2026-11-18, HTTP 401). The rest
// follow the envelope and messages of https://docs.dataforseo.com/v3/appendix/errors/ until the
// account can record them, and html-502.bin is nginx's built-in 502 page (DataForSEO answers as
// `Server: nginx`).
const bytes = (path: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/${path}`, import.meta.url)));

// Spacing and escaped slashes as the sandbox prints them.
const GEMINI_OK = new TextEncoder().encode(
  `{\n    "status_code": 20000,\n    "status_message": "Ok.",\n    "cost": 0.004,\n    "tasks": [\n        {\n            "id": "11181400-1535-0558-0000-6b0e2a1b2c3d",\n            "status_code": 20000,\n            "cost": 0.004,\n            "result": [ { "model": "Fast", "markdown": "Cl\\u00ednica en https:\\/\\/example.co" } ]\n        }\n    ]\n}`,
);

function slot(engine: EngineId): FrozenSlot {
  const geoKey = "co-c1003654";
  const geoDeclared = geoForEngine(engine, getGeo(geoKey), "local", { provider: "dataforseo" });
  if (!geoDeclared) throw new Error(`${engine} is not offered in ${geoKey}`);
  return {
    engine,
    provider: "dataforseo",
    intentSetId: "is_0123456789abcdef",
    intentId: "dental_clinic.best",
    paraphraseId: "p1",
    geoKey,
    geoDeclared,
    runIndex: 0,
    promptText: "¿Cuál es el mejor odontólogo cerca de mí?",
    measurementId: MEASUREMENT,
    slotIndex: 3,
    slotId: slotId(MEASUREMENT, 3),
  };
}

const parseGemini = vi.fn(
  (raw: Uint8Array): EngineAnswer => ({
    parserVersion: "gemini@1",
    engine: "gemini",
    channel: "ui-vendor",
    provider: "dataforseo",
    modelReported: "Fast",
    present: true,
    markdown: JSON.parse(new TextDecoder().decode(raw)).tasks[0].result[0].markdown,
    sources: [],
    searchQueries: "unavailable",
  }),
);

function serve(path: string, body: Uint8Array, init: { status?: number; type?: string } = {}) {
  server.use(
    http.post(
      path,
      () =>
        new HttpResponse(body, {
          status: init.status ?? 200,
          headers: { "content-type": init.type ?? "application/json" },
        }),
    ),
  );
}

function errorOf<E extends Error>(
  outcome: DataForSeoOutcome,
  type: new (...args: never[]) => E,
): E {
  if (outcome.ok) throw new Error("expected a failed outcome");
  expect(outcome.error).toBeInstanceOf(type);
  return outcome.error as E;
}

const ok200 = (code: number) => ({
  httpStatus: 200,
  body: { status_code: 20000, tasks: [{ status_code: code }] },
  timedOut: false,
});

beforeAll(() => server.listen());
beforeEach(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("DATAFORSEO_LOGIN", "capture-unit@example.com");
  vi.stubEnv("DATAFORSEO_PASSWORD", "capture-unit-password");
  resetAppEnv();
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetAppEnv();
});
afterAll(() => server.close());

describe("mapDataForSeoStatus", () => {
  test.each([
    [{ status_code: 20000, tasks: [{ status_code: 20000 }] }, { ok: true }],
    [{ status_code: 20000, tasks: [{ status_code: 20100 }] }, { ok: true }],
    [
      { status_code: 20000, tasks: [{ status_code: 40209 }] },
      { ok: false, retryable: true, breakerFailure: false },
    ],
    [{ status_code: 40202 }, { ok: false, retryable: true, breakerFailure: false }],
    [{ status_code: 40210 }, { ok: false, retryable: false, alert: "balance" }],
    [{ status_code: 40200 }, { ok: false, retryable: false, alert: "balance" }],
    [{ status_code: 40203 }, { ok: false, retryable: false, alert: "balance" }],
    [{ status_code: 40501 }, { ok: false, retryable: false, breakerFailure: false }],
    [
      { status_code: 20000, tasks: [{ status_code: 40506 }] },
      { ok: false, retryable: false, breakerFailure: false },
    ],
    [
      { status_code: 20000, tasks: [{ status_code: 40103 }] },
      { ok: false, retryable: true, breakerFailure: false },
    ],
    [{ status_code: 50000 }, { ok: false, retryable: true, breakerFailure: true }],
    [
      { status_code: 20000, tasks: [{ status_code: 50401 }] },
      { ok: false, retryable: true, breakerFailure: true },
    ],
  ])("%o", (body, expected) =>
    expect(mapDataForSeoStatus({ httpStatus: 200, body, timedOut: false })).toMatchObject(expected),
  );

  test("40209 maps to RateLimited with a 5 s retry", () => {
    expect(errorOf(mapDataForSeoStatus(ok200(40209)), RateLimitedError).retryAfterMs).toBe(5000);
  });

  test("billing exhaustion is a non-retryable rejection naming the cause", () => {
    const outcome = mapDataForSeoStatus({
      httpStatus: 200,
      body: { status_code: 40210 },
      timedOut: false,
    });
    expect(outcome).toMatchObject({ ok: false, alert: "balance" });
    expect(errorOf(outcome, ProviderRejectedError).providerCode).toBe("insufficient_funds");
  });

  test("an unverified account (HTTP 403, 40104) is rejected for good, naming the cause", () => {
    const outcome = mapDataForSeoStatus({
      httpStatus: 403,
      body: { status_code: 40104, status_message: "Please verify your account." },
      timedOut: false,
    });
    expect(outcome).toMatchObject({ ok: false, retryable: false, breakerFailure: false });
    const error = errorOf(outcome, ProviderRejectedError);
    expect(error.providerCode).toBe("account_not_verified");
    expect(error.message).toContain("account_not_verified");
    expect(outcome).not.toHaveProperty("alert");
  });

  test("a timeout at 115 s is a retryable breaker failure", () => {
    const outcome = mapDataForSeoStatus({ httpStatus: 200, body: null, timedOut: true });
    expect(outcome).toMatchObject({ ok: false, retryable: true, breakerFailure: true });
    errorOf(outcome, ProviderUnavailableError);
  });

  test.each([
    [
      { httpStatus: 502, body: null },
      { retryable: true, breakerFailure: true },
    ],
    [
      { httpStatus: 200, body: null },
      { retryable: true, breakerFailure: true },
    ],
    [{ httpStatus: 200, body: { status_code: 20000, tasks: [] } }, { retryable: true }],
    [
      { httpStatus: 429, body: null },
      { retryable: true, breakerFailure: false },
    ],
    [
      { httpStatus: 404, body: null },
      { retryable: false, breakerFailure: false },
    ],
  ])("without a status in the body, HTTP decides: %o", (input, expected) =>
    expect(mapDataForSeoStatus({ ...input, timedOut: false })).toMatchObject({
      ok: false,
      ...expected,
    }),
  );

  test("429 without a body is RateLimited", () => {
    const outcome = mapDataForSeoStatus({ httpStatus: 429, body: null, timedOut: false });
    errorOf(outcome, RateLimitedError);
  });

  test("error messages never carry the response body", () => {
    const body = { status_code: 40501, status_message: "Invalid Field: 'keyword' secret prompt" };
    const outcome = mapDataForSeoStatus({ httpStatus: 200, body, timedOut: false });
    expect(errorOf(outcome, ProviderRejectedError).message).not.toContain("secret prompt");
  });
});

describe("captureLive", () => {
  test("the measured cost and model come from the response", async () => {
    serve(GEMINI_LIVE, GEMINI_OK);
    const r = await captureLive(slot("gemini"), parseGemini);
    expect(r).toMatchObject({
      status: "succeeded",
      providerStatusCode: 20000,
      httpStatus: 200,
      cost: { amount_micros: 4000, currency: "USD" },
      modelReported: "Fast",
      providerTaskId: "11181400-1535-0558-0000-6b0e2a1b2c3d",
      endpoint: expect.stringMatching(
        /\/v3\/ai_optimization\/gemini\/llm_scraper\/live\/advanced$/,
      ),
      responseContentType: "application/json",
      parseError: null,
      mode: "live",
      answer: { markdown: "Clínica en https://example.co" },
    });
    expect(r.captureId).toMatch(/^cap_/);
    expect(r.slot.slotId).toBe(`${MEASUREMENT}:3`);
    expect(Buffer.from(r.response).equals(Buffer.from(GEMINI_OK))).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(r.request))).toEqual([
      expect.objectContaining({ tag: `${MEASUREMENT}:3` }),
    ]);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(jobs.breakerRecord).toHaveBeenCalledExactlyOnceWith("dataforseo", "success");
  });

  test("each engine goes to its own Live endpoint", async () => {
    const seen: string[] = [];
    server.use(
      http.post("*/v3/*", ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json({ status_code: 20000, tasks: [{ status_code: 20000 }] });
      }),
    );
    const parse = vi.fn(() => parseGemini(GEMINI_OK));
    for (const engine of ["gemini", "chatgpt", "google-ai-overview", "google-ai-mode"] as const) {
      await captureLive(slot(engine), parse);
    }
    expect(seen).toEqual([
      "/v3/ai_optimization/gemini/llm_scraper/live/advanced",
      "/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced",
      "/v3/serp/google/organic/live/advanced",
      "/v3/serp/google/ai_mode/live/advanced",
    ]);
  });

  test("a 40210 capture keeps its bytes with provider_error", async () => {
    const body = bytes("errors/40210.bin");
    serve(GEMINI_LIVE, body);
    const r = await captureLive(slot("gemini"), parseGemini);
    expect(r).toMatchObject({
      status: "provider_error",
      providerStatusCode: 40210,
      answer: null,
      parseError: null,
      cost: { amount_micros: 0, currency: "USD" },
    });
    expect(Buffer.from(r.response).equals(Buffer.from(body))).toBe(true);
    expect(parseGemini).not.toHaveBeenCalled();
    expect(jobs.breakerRecord).toHaveBeenCalledExactlyOnceWith("dataforseo", "success");
  });

  test("a task error inside a 20000 envelope is a provider_error mapped by the task", async () => {
    serve(GEMINI_LIVE, bytes("errors/40209.bin"));
    const r = await captureLive(slot("gemini"), parseGemini);
    expect(r).toMatchObject({ status: "provider_error", providerStatusCode: 40209 });
  });

  test("an HTTP 401 from the sandbox is sealed as a provider_error", async () => {
    const body = bytes("recorded/errors/40100.bin");
    serve(AI_MODE_LIVE, body, { status: 401 });
    const r = await captureLive(slot("google-ai-mode"), parseGemini);
    expect(r).toMatchObject({
      status: "provider_error",
      httpStatus: 401,
      providerStatusCode: 40100,
    });
    expect(Buffer.from(r.response).equals(Buffer.from(body))).toBe(true);
  });

  test("a 50000 counts as a breaker failure", async () => {
    serve(GEMINI_LIVE, bytes("errors/50000.bin"));
    const r = await captureLive(slot("gemini"), parseGemini);
    expect(r.status).toBe("provider_error");
    expect(jobs.breakerRecord).toHaveBeenCalledExactlyOnceWith("dataforseo", "failure");
  });

  test("an HTML 502 body is kept as is with a parse error", async () => {
    const body = bytes("errors/html-502.bin");
    serve(GEMINI_LIVE, body, { status: 502, type: "text/html" });
    const r = await captureLive(slot("gemini"), parseGemini);
    expect(r).toMatchObject({
      status: "provider_error",
      httpStatus: 502,
      providerStatusCode: null,
      answer: null,
      cost: null,
      responseContentType: "text/html",
    });
    expect(r.parseError).toEqual(expect.any(String));
    expect(r.parseError).not.toContain("Bad Gateway");
    expect(Buffer.from(r.response).equals(Buffer.from(body))).toBe(true);
    expect(jobs.breakerRecord).toHaveBeenCalledExactlyOnceWith("dataforseo", "failure");
  });

  test("an answer that does not parse is still a succeeded capture with its error", async () => {
    serve(GEMINI_LIVE, GEMINI_OK);
    const r = await captureLive(slot("gemini"), () => {
      throw new Error("unexpected shape");
    });
    expect(r).toMatchObject({ status: "succeeded", answer: null, parseError: expect.any(String) });
  });

  test("a body cut by the timeout keeps the status and is a timeout capture", async () => {
    // A stubbed fetch: undici asserts when MSW's socket closes after an abort mid-body.
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status_code":'));
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    });
    const r = await captureLive(slot("gemini"), parseGemini, { timeoutMs: 50 });
    expect(r).toMatchObject({ status: "timeout", httpStatus: 200, cost: null, answer: null });
    expect(r.response.length).toBe(0);
    expect(jobs.breakerRecord).toHaveBeenCalledExactlyOnceWith("dataforseo", "failure");
  });

  test("when nothing arrives it throws ProviderUnavailable and counts a failure", async () => {
    server.use(http.post(GEMINI_LIVE, () => HttpResponse.error()));
    await expect(captureLive(slot("gemini"), parseGemini)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(jobs.breakerRecord).toHaveBeenCalledExactlyOnceWith("dataforseo", "failure");
  });

  test("a slot of another provider never calls DataForSEO", async () => {
    await expect(
      captureLive({ ...slot("gemini"), provider: "brightdata" }, parseGemini),
    ).rejects.toThrow(/brightdata/);
    expect(jobs.breakerRecord).not.toHaveBeenCalled();
  });
});
