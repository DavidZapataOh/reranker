import { readFileSync } from "node:fs";
import { geoForEngine, getGeo } from "@reranker/catalog";
import { resetAppEnv } from "@reranker/env";
import {
  InvalidInputError,
  ProviderRejectedError,
  ProviderUnavailableError,
  RateLimitedError,
} from "@reranker/jobs/errors";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { openaiAdapter } from "../../src/openai/adapter";
import { CONTROL_RESERVE, costFromUsage } from "../../src/openai/cost";
import { type FrozenSlot, slotId } from "../../src/slot";

const jobs = vi.hoisted(() => ({
  breakerRecord: vi.fn(async (_provider: string, _outcome: "success" | "failure") => {}),
}));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  ...jobs,
}));

const RESPONSES = "https://api.openai.com/v1/responses";
const MEASUREMENT = "0193b6f2-7c1e-7a51-9b3a-5f2e8d4c1a90";
const recorded = (name: string) =>
  readFileSync(new URL(`../fixtures/recorded/openai/${name}`, import.meta.url));
const WIRE = recorded("control-medellin.json");
const WIRE_HEADERS = JSON.parse(recorded("control-medellin.headers.json").toString());
const body = JSON.parse(WIRE.toString());

function slot(provider: "openai" | "dataforseo" = "openai"): FrozenSlot {
  const geoKey = "co-c1003654";
  const geoDeclared = geoForEngine("chatgpt", getGeo(geoKey), "local", { provider });
  if (!geoDeclared) throw new Error("ChatGPT is not offered in Colombia");
  return {
    engine: "chatgpt",
    provider,
    intentSetId: "is_0123456789abcdef",
    intentId: "dental_clinic.best",
    paraphraseId: "p1",
    geoKey,
    geoDeclared,
    runIndex: 0,
    promptText: "¿Qué odontólogo me recomiendas en Medellín?",
    measurementId: MEASUREMENT,
    slotIndex: 0,
    slotId: slotId(MEASUREMENT, 0),
  };
}

const serve = (reply: () => Response | Promise<Response>) =>
  server.use(http.post(RESPONSES, reply));
const errorReply = (status: number, code: string, headers: Record<string, string> = {}) =>
  HttpResponse.json(
    { error: { message: "¿Qué odontólogo…", type: "invalid_request_error", code } },
    { status, headers },
  );

beforeAll(() => server.listen());
beforeEach(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("OPENAI_CONTROL_API_KEY", "sk-control-unit");
  resetAppEnv();
  jobs.breakerRecord.mockClear();
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
  resetAppEnv();
});
afterAll(() => server.close());

test("reserves the control hold for each call", () =>
  expect(openaiAdapter.estimate?.(slot())).toEqual(CONTROL_RESERVE));

test("a completed call is a succeeded record with its answer, model and billed cost", async () => {
  serve(() => new HttpResponse(WIRE, { headers: WIRE_HEADERS }));
  const record = await openaiAdapter.captureLive(slot());
  expect(record).toMatchObject({
    status: "succeeded",
    httpStatus: 200,
    endpoint: RESPONSES,
    providerTaskId: body.id,
    modelReported: body.model,
    cost: costFromUsage(body.usage, 1, body.model),
    parseError: null,
    mode: "live",
  });
  expect(Buffer.from(record.response).equals(WIRE)).toBe(true);
  expect(record.answer?.meta?.requestId).toBe(WIRE_HEADERS["x-request-id"]);
  expect(record.failure).toBeUndefined();
  expect(jobs.breakerRecord).toHaveBeenCalledWith("openai", "success");
});

test("a model missing from the price table keeps the full hold instead of a guess", async () => {
  serve(() => HttpResponse.json({ ...body, model: "gpt-unpriced" }));
  expect((await openaiAdapter.captureLive(slot())).cost).toBeNull();
});

test("a 400 is sealed as a provider error that costs nothing and is not retried", async () => {
  serve(() => errorReply(400, "invalid_value"));
  const record = await openaiAdapter.captureLive(slot());
  expect(record).toMatchObject({
    status: "provider_error",
    httpStatus: 400,
    answer: null,
    cost: { amount_micros: 0 },
    failure: { retryable: false },
  });
  expect(record.failure?.error).toBeInstanceOf(ProviderRejectedError);
  expect(jobs.breakerRecord).toHaveBeenCalledWith("openai", "success");
});

test("a 429 is sealed and retried after the advertised wait", async () => {
  serve(() => errorReply(429, "rate_limit_exceeded", { "retry-after": "2" }));
  const record = await openaiAdapter.captureLive(slot());
  expect(record.failure).toMatchObject({ retryable: true });
  expect(record.failure?.error).toMatchObject({ retryAfterMs: 2000 });
  expect(record.failure?.error).toBeInstanceOf(RateLimitedError);
});

test("a 503 counts against the breaker", async () => {
  serve(() => errorReply(503, "server_error"));
  const record = await openaiAdapter.captureLive(slot());
  expect(record.failure?.error).toBeInstanceOf(ProviderUnavailableError);
  expect(jobs.breakerRecord).toHaveBeenCalledWith("openai", "failure");
});

test("nothing back at all throws, after counting a breaker failure", async () => {
  serve(() => HttpResponse.error());
  await expect(openaiAdapter.captureLive(slot())).rejects.toBeInstanceOf(ProviderUnavailableError);
  expect(jobs.breakerRecord).toHaveBeenCalledWith("openai", "failure");
});

test("a 200 that is not JSON is sealed with its parse error and keeps the full hold", async () => {
  serve(() => new HttpResponse("<html>", { headers: { "content-type": "text/html" } }));
  const record = await openaiAdapter.captureLive(slot());
  expect(record).toMatchObject({
    status: "succeeded",
    answer: null,
    cost: null,
    modelReported: null,
    providerTaskId: null,
    responseContentType: "text/html",
  });
  expect(record.parseError).toMatch(/\S/);
});

test("a response without usage keeps the full hold", async () => {
  const { usage: _, output: __, ...bare } = body;
  serve(() => HttpResponse.json({ ...bare, output: "none" }));
  expect((await openaiAdapter.captureLive(slot())).cost).toBeNull();
  serve(() => HttpResponse.json({ ...body, output: "none" }));
  expect((await openaiAdapter.captureLive(slot())).cost).toEqual(
    costFromUsage(body.usage, 0, body.model),
  );
});

test("a slot routed elsewhere or a drifted profile is refused before any call", async () => {
  const calls = vi.fn(() => HttpResponse.json(body));
  serve(calls);
  await expect(openaiAdapter.captureLive(slot("dataforseo"))).rejects.toBeInstanceOf(
    InvalidInputError,
  );
  vi.stubEnv("OPENAI_CONTROL_MODEL", "gpt-6-astra");
  await expect(openaiAdapter.captureLive(slot())).rejects.toThrow(/control-chatgpt@2/);
  expect(calls).not.toHaveBeenCalled();
  expect(jobs.breakerRecord).not.toHaveBeenCalled();
});
