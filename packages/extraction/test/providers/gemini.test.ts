import { readFileSync } from "node:fs";
import { ProviderRejectedError, ProviderUnavailableError, RateLimitedError } from "@reranker/jobs";
import { z } from "@reranker/schema";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { callGemini } from "../../src/providers/gemini";
import type { StructuredCall } from "../../src/providers/types";
import { type MentionsOutput, MentionsSchema } from "../../src/schema";

const jobs = vi.hoisted(() => ({
  breakerRecord: vi.fn(async (_provider: string, _outcome: "success" | "failure") => {}),
}));

vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  ...jobs,
}));

const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1/interactions";
const API_KEY = "gemini-unit-key";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../fixtures/gemini/${name}.json`, import.meta.url), "utf8"));

const call: StructuredCall<MentionsOutput> = {
  model: { provider: "gemini", model: "gemini-3.1-flash-lite", reasoning: "minimal" },
  system: "Extrae las menciones de la respuesta.",
  user: "Te recomiendo la Clínica Dental Sonrisa Paisa en El Poblado; también puedes mirar Doctoralia.",
  schema: MentionsSchema,
  schemaName: "mentions",
  signal: AbortSignal.timeout(5000),
  maxOutputTokens: 2048,
};

function respond(reply: () => Response = () => HttpResponse.json(fixture("completed"))) {
  const bodies: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  server.use(
    http.post(INTERACTIONS_URL, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      headers.push(Object.fromEntries(request.headers));
      return reply();
    }),
  );
  return { bodies, headers };
}

function apiError(status: number, code: string, init?: Record<string, string>) {
  return () =>
    HttpResponse.json(
      { error: { code, message: "detail that may echo the input" } },
      { status, ...(init && { headers: init }) },
    );
}

// Thinking tokens (40) are billed as output, on top of the 288 answer tokens.
const completedUsage = {
  inputTokens: 1512,
  cachedInputTokens: 1024,
  cacheWriteTokens: 0,
  outputTokens: 328,
};

beforeAll(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("GEMINI_API_KEY", API_KEY);
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});

test("gemini sends response_format with the JSON schema, store false and the thinking level", async () => {
  const { bodies, headers } = respond();
  await callGemini(call);
  const body = bodies[0];
  expect(headers[0]?.["x-goog-api-key"]).toBe(API_KEY);
  expect(body?.model).toBe("gemini-3.1-flash-lite");
  expect(body?.system_instruction).toBe(call.system);
  expect(body?.input).toBe(call.user);
  expect(body?.response_format).toEqual({
    type: "text",
    mime_type: "application/json",
    schema: z.toJSONSchema(MentionsSchema),
  });
  expect(body?.store).toBe(false);
  expect(body?.generation_config).toEqual({ thinking_level: "minimal", max_output_tokens: 2048 });
  expect(body).not.toHaveProperty("automatic_continuation");
});

test("gemini-3.8-flash never gets minimal, and low reasoning asks for low", async () => {
  const { bodies } = respond();
  await callGemini({ ...call, model: { ...call.model, model: "gemini-3.8-flash" } });
  await callGemini({ ...call, model: { ...call.model, reasoning: "low" } });
  await callGemini({ ...call, model: { ...call.model, reasoning: "none" } });
  expect(
    bodies.map((b) => (b.generation_config as { thinking_level: string }).thinking_level),
  ).toEqual(["low", "low", "minimal"]);
});

test("returns the parsed output, the reported model and usage with thinking billed as output", async () => {
  respond();
  const result = await callGemini(call);
  expect(result.output.mentions).toHaveLength(2);
  expect(result.output.mentions[1]?.citedUrls).toEqual(["https://www.doctoralia.co"]);
  expect(result.modelReported).toBe("gemini-3.1-flash-lite");
  expect(result.usage).toEqual(completedUsage);
  expect(result.raw).toMatchObject({ id: expect.stringMatching(/^v1_/) });
  expect(jobs.breakerRecord).toHaveBeenCalledWith("gemini", "success");
});

test("gemini output is validated with zod; a schema violation is ProviderIncomplete(invalid_output)", async () => {
  respond(() => HttpResponse.json(fixture("gemini-bad-enum")));
  await expect(callGemini(call)).rejects.toMatchObject({
    name: "ProviderIncomplete",
    provider: "gemini",
    reason: "invalid_output",
    usage: completedUsage,
  });
});

test("an answer without text is invalid_output with usage", async () => {
  const empty = fixture("completed");
  empty.steps = (empty.steps as unknown[]).slice(0, 1);
  respond(() => HttpResponse.json(empty));
  await expect(callGemini(call)).rejects.toMatchObject({
    name: "ProviderIncomplete",
    reason: "invalid_output",
    usage: completedUsage,
  });
});

test("status incomplete becomes ProviderIncompleteError with the billed usage", async () => {
  respond(() => HttpResponse.json(fixture("incomplete")));
  await expect(callGemini(call)).rejects.toMatchObject({
    name: "ProviderIncomplete",
    provider: "gemini",
    reason: "incomplete",
    usage: { ...completedUsage, outputTokens: 2048 },
  });
});

test("a generation blocked by policy is ProviderRefusal with usage; another failure is incomplete", async () => {
  respond(() => HttpResponse.json(fixture("blocked")));
  await expect(callGemini(call)).rejects.toMatchObject({
    name: "ProviderRefusal",
    provider: "gemini",
    message: "safety",
    usage: { ...completedUsage, outputTokens: 12 },
  });

  const failed = fixture("blocked");
  failed.errors = [{ code: "malformed_function_call", message: "detail" }];
  respond(() => HttpResponse.json(failed));
  await expect(callGemini(call)).rejects.toMatchObject({
    name: "ProviderIncomplete",
    reason: "malformed_function_call",
  });
});

test("an answer without usage is ProviderIncomplete(missing_usage) and carries no usage", async () => {
  const unmetered = fixture("completed");
  delete unmetered.usage;
  respond(() => HttpResponse.json(unmetered));
  const error = await callGemini(call).catch((e: unknown) => e);
  expect(error).toMatchObject({ name: "ProviderIncomplete", reason: "missing_usage" });
  expect((error as { usage?: unknown }).usage).toBeUndefined();
});

test("a 429 rate limit becomes RateLimitedError, once and with the advertised delay", async () => {
  const { bodies } = respond(apiError(429, "rate_limit_exceeded", { "retry-after": "7" }));
  const error = await callGemini(call).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RateLimitedError);
  expect(error).toMatchObject({ retryAfterMs: 7000 });
  expect(bodies).toHaveLength(1);
  expect(jobs.breakerRecord).toHaveBeenCalledWith("gemini", "success");

  respond(apiError(429, "too_many_requests"));
  await expect(callGemini(call)).rejects.toMatchObject({ retryAfterMs: 1000 });
});

test.each([
  [402, "payment_required"],
  [429, "quota_exceeded"],
])("a %i %s cannot be fixed by waiting and is ProviderRejected", async (status, code) => {
  respond(apiError(status, code));
  const error = await callGemini(call).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderRejectedError);
  expect(error).toMatchObject({ provider: "gemini", providerCode: code });
});

test.each([
  [500, "api_error"],
  [503, "service_unavailable"],
  [504, "deadline_exceeded"],
])("a %i becomes ProviderUnavailableError and a breaker failure", async (status, code) => {
  const { bodies } = respond(apiError(status, code, { "retry-after": "3" }));
  const error = await callGemini(call).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderUnavailableError);
  expect(error).toMatchObject({ provider: "gemini", retryAfterMs: 3000 });
  expect(bodies).toHaveLength(1);
  expect(jobs.breakerRecord).toHaveBeenCalledWith("gemini", "failure");
});

test("a lost connection or an exhausted deadline is ProviderUnavailable", async () => {
  respond(() => HttpResponse.error());
  await expect(callGemini(call)).rejects.toBeInstanceOf(ProviderUnavailableError);
  expect(jobs.breakerRecord).toHaveBeenLastCalledWith("gemini", "failure");

  respond();
  const expired = { ...call, signal: AbortSignal.abort(new DOMException("t", "TimeoutError")) };
  await expect(callGemini(expired)).rejects.toBeInstanceOf(ProviderUnavailableError);
});

test("any other 4xx is ProviderRejected with Gemini's code only", async () => {
  respond(apiError(400, "invalid_request"));
  const error = await callGemini(call).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderRejectedError);
  expect(error).toMatchObject({ providerCode: "invalid_request" });
  expect(String((error as Error).message)).not.toContain("echo the input");
  expect(jobs.breakerRecord).toHaveBeenLastCalledWith("gemini", "success");

  respond(() => HttpResponse.text("forbidden", { status: 403 }));
  await expect(callGemini(call)).rejects.toMatchObject({ providerCode: "http_403" });
});
