import { readFileSync } from "node:fs";
import { ProviderRejectedError, ProviderUnavailableError, RateLimitedError } from "@reranker/jobs";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { callOpenAI } from "../../src/providers/openai";
import type { StructuredCall } from "../../src/providers/types";
import { type MentionsOutput, MentionsSchema } from "../../src/schema";

const jobs = vi.hoisted(() => ({
  breakerRecord: vi.fn(async (_provider: string, _outcome: "success" | "failure") => {}),
}));

vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  ...jobs,
}));

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const API_KEY = "sk-unit-openai";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../fixtures/openai/${name}.json`, import.meta.url), "utf8"));

const call: StructuredCall<MentionsOutput> = {
  model: { provider: "openai", model: "gpt-6-luna", reasoning: "low" },
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
    http.post(RESPONSES_URL, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      headers.push(Object.fromEntries(request.headers));
      return reply();
    }),
  );
  return { bodies, headers };
}

function apiError(status: number, error: Record<string, unknown>, init?: Record<string, string>) {
  return () =>
    HttpResponse.json(
      { error: { message: "detail that may echo the input", param: null, ...error } },
      { status, ...(init && { headers: init }) },
    );
}

beforeAll(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("OPENAI_API_KEY", API_KEY);
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

test("sends the strict json_schema format, low reasoning and no temperature", async () => {
  const { bodies, headers } = respond();
  await callOpenAI(call);
  const body = bodies[0];
  expect(headers[0]?.authorization).toBe(`Bearer ${API_KEY}`);
  expect(body?.model).toBe("gpt-6-luna");
  expect(body?.text).toMatchObject({
    format: { type: "json_schema", name: "mentions", strict: true },
  });
  expect(body?.reasoning).toEqual({ effort: "low" });
  expect(body).not.toHaveProperty("temperature");
  expect(body?.max_output_tokens).toBe(call.maxOutputTokens);
  expect(body?.store).toBe(false);
});

test("only the fixed system prompt is written to the prompt cache", async () => {
  const { bodies } = respond();
  await callOpenAI(call);
  const body = bodies[0];
  expect(body?.prompt_cache_options).toEqual({ mode: "explicit" });
  // Top-level instructions cannot hold a breakpoint, so the system prompt is a developer message.
  expect(body).not.toHaveProperty("instructions");
  expect(body?.input).toEqual([
    {
      role: "developer",
      content: [
        {
          type: "input_text",
          text: call.system,
          prompt_cache_breakpoint: { mode: "explicit" },
        },
      ],
    },
    { role: "user", content: call.user },
  ]);
});

test("returns the parsed output, the reported model and usage with cached tokens", async () => {
  respond();
  const result = await callOpenAI(call);
  expect(result.output.mentions).toHaveLength(2);
  expect(result.output.mentions[0]?.name).toBe("Clínica Dental Sonrisa Paisa");
  expect(result.modelReported).toBe("gpt-6-luna");
  expect(result.usage).toEqual({
    inputTokens: 1512,
    cachedInputTokens: 1024,
    cacheWriteTokens: 0,
    outputTokens: 288,
  });
  expect(result.raw).toMatchObject({ id: "resp_0c1f8e2a7b9d4e6f" });
  expect(jobs.breakerRecord).toHaveBeenCalledWith("openai", "success");
});

test("the first call of a prefix reports its cache write", async () => {
  const cold = fixture("completed");
  cold.usage = {
    input_tokens: 1512,
    input_tokens_details: {
      cached_tokens: 0,
      cache_write_tokens: 1100,
      cache_write_tokens_details: { ttl_30m_tokens: 1100, ttl_12h_tokens: 0 },
    },
    output_tokens: 288,
    output_tokens_details: { reasoning_tokens: 96 },
    total_tokens: 1800,
  };
  respond(() => HttpResponse.json(cold));
  expect((await callOpenAI(call)).usage).toEqual({
    inputTokens: 1512,
    cachedInputTokens: 0,
    cacheWriteTokens: 1100,
    outputTokens: 288,
  });
});

test("a refusal item becomes ProviderRefusalError", async () => {
  respond(() => HttpResponse.json(fixture("refusal")));
  await expect(callOpenAI(call)).rejects.toMatchObject({
    name: "ProviderRefusal",
    provider: "openai",
  });
  expect(jobs.breakerRecord).toHaveBeenCalledWith("openai", "success");
});

test("status incomplete becomes ProviderIncompleteError with its reason", async () => {
  respond(() => HttpResponse.json(fixture("incomplete-max-output-tokens")));
  await expect(callOpenAI(call)).rejects.toMatchObject({
    name: "ProviderIncomplete",
    provider: "openai",
    reason: "max_output_tokens",
  });
});

test("output that does not match the schema is ProviderIncomplete(invalid_output)", async () => {
  const bad = fixture("completed");
  const [reasoning, message] = bad.output as [unknown, { content: { text: string }[] }];
  message.content = [{ ...message.content[0], text: '{"answerKind":"maybe","mentions":[]}' }];
  bad.output = [reasoning, message];
  respond(() => HttpResponse.json(bad));
  await expect(callOpenAI(call)).rejects.toMatchObject({
    name: "ProviderIncomplete",
    reason: "invalid_output",
  });
  expect(jobs.breakerRecord).toHaveBeenCalledWith("openai", "success");
});

test("a completed response without a final message is ProviderIncomplete(invalid_output)", async () => {
  const empty = fixture("completed");
  empty.output = (empty.output as unknown[]).slice(0, 1);
  respond(() => HttpResponse.json(empty));
  await expect(callOpenAI(call)).rejects.toMatchObject({
    name: "ProviderIncomplete",
    reason: "invalid_output",
  });
});

test("a 429 rate limit becomes RateLimitedError with the advertised delay", async () => {
  respond(apiError(429, { type: "rate_limit_error", code: "slow_down" }, { "retry-after": "7" }));
  const error = await callOpenAI(call).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RateLimitedError);
  expect(error).toMatchObject({ retryAfterMs: 7000 });
  expect(jobs.breakerRecord).toHaveBeenCalledWith("openai", "success");
});

test("retry-after-ms wins over retry-after, and a missing header waits one second", async () => {
  respond(
    apiError(
      429,
      { type: "requests", code: null },
      { "retry-after-ms": "250", "retry-after": "9" },
    ),
  );
  await expect(callOpenAI(call)).rejects.toMatchObject({ retryAfterMs: 250 });
  respond(apiError(429, { type: "tokens", code: null }));
  await expect(callOpenAI(call)).rejects.toMatchObject({ retryAfterMs: 1000 });
});

test.each([
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
])("a 429 %s cannot be fixed by waiting and is ProviderRejected", async (code) => {
  respond(apiError(429, { type: "insufficient_quota", code }));
  const error = await callOpenAI(call).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderRejectedError);
  expect(error).toMatchObject({ provider: "openai", providerCode: code });
});

test.each([500, 502, 503])(
  "a %i becomes ProviderUnavailableError and a breaker failure",
  async (status) => {
    respond(
      apiError(
        status,
        { type: "service_unavailable_error", code: "server_is_overloaded" },
        {
          "retry-after": "3",
        },
      ),
    );
    const error = await callOpenAI(call).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).toMatchObject({ provider: "openai", retryAfterMs: 3000 });
    expect(jobs.breakerRecord).toHaveBeenCalledWith("openai", "failure");
  },
);

test("a lost connection or an exhausted deadline is ProviderUnavailable", async () => {
  respond(() => HttpResponse.error());
  await expect(callOpenAI(call)).rejects.toBeInstanceOf(ProviderUnavailableError);
  expect(jobs.breakerRecord).toHaveBeenLastCalledWith("openai", "failure");

  respond();
  const expired = { ...call, signal: AbortSignal.abort(new DOMException("t", "TimeoutError")) };
  await expect(callOpenAI(expired)).rejects.toBeInstanceOf(ProviderUnavailableError);
});

test("any other 4xx is ProviderRejected with OpenAI's code only", async () => {
  respond(apiError(400, { type: "invalid_request_error", code: "invalid_json_schema" }));
  const error = await callOpenAI(call).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderRejectedError);
  expect(error).toMatchObject({ providerCode: "invalid_json_schema" });
  expect(String((error as Error).message)).not.toContain("echo the input");

  respond(apiError(401, { type: "invalid_request_error", code: null }));
  await expect(callOpenAI(call)).rejects.toMatchObject({ providerCode: "http_401" });
  expect(jobs.breakerRecord).toHaveBeenLastCalledWith("openai", "success");
});
