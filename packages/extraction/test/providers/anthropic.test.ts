import { readFileSync } from "node:fs";
import { ProviderRejectedError, ProviderUnavailableError, RateLimitedError } from "@reranker/jobs";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { callAnthropic } from "../../src/providers/anthropic";
import type { StructuredCall } from "../../src/providers/types";
import { type MentionsOutput, MentionsSchema } from "../../src/schema";

const jobs = vi.hoisted(() => ({
  breakerRecord: vi.fn(async (_provider: string, _outcome: "success" | "failure") => {}),
}));

vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  ...jobs,
}));

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const API_KEY = "sk-ant-unit-anthropic";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../fixtures/anthropic/${name}.json`, import.meta.url), "utf8"));

const anthropicCall: StructuredCall<MentionsOutput> = {
  model: { provider: "anthropic", model: "claude-haiku-5-5", reasoning: "low" },
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
    http.post(MESSAGES_URL, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      headers.push(Object.fromEntries(request.headers));
      return reply();
    }),
  );
  return { bodies, headers };
}

function apiError(
  status: number,
  error: Record<string, unknown>,
  init?: Record<string, string>,
): () => Response {
  return () =>
    HttpResponse.json(
      {
        type: "error",
        error: { message: "detail that may echo the input", ...error },
        request_id: "req_011CVyLhHCzG6S8wQdZgWm7J",
      },
      { status, ...(init && { headers: init }) },
    );
}

// input_tokens (488) excludes the 1,024 tokens read from the cache.
const completedUsage = {
  inputTokens: 1512,
  cachedInputTokens: 1024,
  cacheWriteTokens: 0,
  outputTokens: 288,
};

beforeAll(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("ANTHROPIC_API_KEY", API_KEY);
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

test("anthropic uses output_config.format and returns parsed_output", async () => {
  const { bodies, headers } = respond();
  const result = await callAnthropic(anthropicCall);
  const body = bodies[0] as {
    output_config: { format: { type: string; schema: Record<string, unknown> }; effort: string };
  } & Record<string, unknown>;
  expect(headers[0]?.authorization).toBe(`Bearer ${API_KEY}`);
  expect(body.model).toBe("claude-haiku-5-5");
  expect(body.max_tokens).toBe(2048);
  expect(body.output_config.format.type).toBe("json_schema");
  expect(body.output_config.format.schema).toMatchObject({
    type: "object",
    required: ["answerKind", "mentions"],
    additionalProperties: false,
  });
  expect(body.output_config.effort).toBe("low");
  expect(body).not.toHaveProperty("thinking");
  expect(body).not.toHaveProperty("temperature");
  expect(result.output.answerKind).toBe("names_entities");
  expect(result.output.mentions).toHaveLength(2);
});

test("only the fixed system prompt is written to the prompt cache", async () => {
  const { bodies } = respond();
  await callAnthropic(anthropicCall);
  expect(bodies[0]?.system).toEqual([
    { type: "text", text: anthropicCall.system, cache_control: { type: "ephemeral" } },
  ]);
  expect(bodies[0]?.messages).toEqual([{ role: "user", content: anthropicCall.user }]);
  expect(bodies[0]).not.toHaveProperty("cache_control");
});

test("returns the reported model and usage with cache reads and writes added to the input", async () => {
  respond();
  const result = await callAnthropic(anthropicCall);
  expect(result.modelReported).toBe("claude-haiku-5-5");
  expect(result.usage).toEqual(completedUsage);
  expect(result.raw).toMatchObject({ id: "msg_01XFDUDYJgAACzvnptvVoYEL" });
  expect(jobs.breakerRecord).toHaveBeenCalledWith("anthropic", "success");

  const cold = fixture("completed");
  cold.usage = {
    ...(cold.usage as Record<string, unknown>),
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 1024,
  };
  respond(() => HttpResponse.json(cold));
  expect((await callAnthropic(anthropicCall)).usage).toEqual({
    ...completedUsage,
    cachedInputTokens: 0,
    cacheWriteTokens: 1024,
  });
});

test("anthropic stop_reason refusal and max_tokens map to typed errors", async () => {
  respond(() => HttpResponse.json(fixture("refusal")));
  await expect(callAnthropic(anthropicCall)).rejects.toMatchObject({
    name: "ProviderRefusal",
    provider: "anthropic",
    message: "general_harms",
    usage: { ...completedUsage, outputTokens: 12 },
  });
  respond(() => HttpResponse.json(fixture("max-tokens")));
  await expect(callAnthropic(anthropicCall)).rejects.toMatchObject({
    name: "ProviderIncomplete",
    reason: "max_tokens",
    usage: { ...completedUsage, outputTokens: 2048 },
  });
  expect(jobs.breakerRecord).toHaveBeenLastCalledWith("anthropic", "success");
});

test.each([
  ["breaks the schema", '{"answerKind":"maybe","mentions":[]}'],
  ["is not JSON", '{"answerKind":"names_entities","mentions":['],
])("output that %s is ProviderIncomplete(invalid_output) with usage", async (_, text) => {
  const message = fixture("completed");
  message.content = [{ type: "text", text, citations: null }];
  respond(() => HttpResponse.json(message));
  await expect(callAnthropic(anthropicCall)).rejects.toMatchObject({
    name: "ProviderIncomplete",
    reason: "invalid_output",
    usage: completedUsage,
  });
});

test("an answer without usage is ProviderIncomplete(missing_usage) and carries no usage", async () => {
  const unmetered = fixture("completed");
  delete unmetered.usage;
  respond(() => HttpResponse.json(unmetered));
  const error = await callAnthropic(anthropicCall).catch((e: unknown) => e);
  expect(error).toMatchObject({ name: "ProviderIncomplete", reason: "missing_usage" });
  expect((error as { usage?: unknown }).usage).toBeUndefined();
});

test("a 429 rate limit becomes RateLimitedError, once and with the advertised delay", async () => {
  const { bodies } = respond(apiError(429, { type: "rate_limit_error" }, { "retry-after": "7" }));
  const error = await callAnthropic(anthropicCall).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RateLimitedError);
  expect(error).toMatchObject({ retryAfterMs: 7000 });
  expect(bodies).toHaveLength(1);
  expect(jobs.breakerRecord).toHaveBeenCalledWith("anthropic", "success");

  respond(apiError(429, { type: "rate_limit_error" }));
  await expect(callAnthropic(anthropicCall)).rejects.toMatchObject({ retryAfterMs: 1000 });
});

test("the monthly spend cap and a billing error cannot be fixed by waiting", async () => {
  respond(
    apiError(429, {
      type: "rate_limit_error",
      details: { error_code: "enforced_spend_limit_reached" },
    }),
  );
  const capped = await callAnthropic(anthropicCall).catch((e: unknown) => e);
  expect(capped).toBeInstanceOf(ProviderRejectedError);
  expect(capped).toMatchObject({
    provider: "anthropic",
    providerCode: "enforced_spend_limit_reached",
  });

  respond(apiError(402, { type: "billing_error" }));
  await expect(callAnthropic(anthropicCall)).rejects.toMatchObject({
    name: "ProviderRejected",
    providerCode: "billing_error",
  });
});

test.each([
  [500, "api_error"],
  [529, "overloaded_error"],
])("a %i becomes ProviderUnavailableError and a breaker failure", async (status, type) => {
  const { bodies } = respond(apiError(status, { type }, { "retry-after": "3" }));
  const error = await callAnthropic(anthropicCall).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderUnavailableError);
  expect(error).toMatchObject({ provider: "anthropic", retryAfterMs: 3000 });
  expect(bodies).toHaveLength(1);
  expect(jobs.breakerRecord).toHaveBeenCalledWith("anthropic", "failure");
});

test("a lost connection or an exhausted deadline is ProviderUnavailable", async () => {
  respond(() => HttpResponse.error());
  await expect(callAnthropic(anthropicCall)).rejects.toBeInstanceOf(ProviderUnavailableError);
  expect(jobs.breakerRecord).toHaveBeenLastCalledWith("anthropic", "failure");

  respond();
  const expired = {
    ...anthropicCall,
    signal: AbortSignal.abort(new DOMException("t", "TimeoutError")),
  };
  await expect(callAnthropic(expired)).rejects.toBeInstanceOf(ProviderUnavailableError);
});

test("any other 4xx is ProviderRejected with Anthropic's error type only", async () => {
  respond(apiError(400, { type: "invalid_request_error" }));
  const error = await callAnthropic(anthropicCall).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderRejectedError);
  expect(error).toMatchObject({ providerCode: "invalid_request_error" });
  expect(String((error as Error).message)).not.toContain("echo the input");
  expect(jobs.breakerRecord).toHaveBeenLastCalledWith("anthropic", "success");

  respond(() => HttpResponse.text("forbidden", { status: 403 }));
  await expect(callAnthropic(anthropicCall)).rejects.toMatchObject({ providerCode: "http_403" });
});
