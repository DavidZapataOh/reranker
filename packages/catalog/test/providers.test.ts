import {
  ProviderRejectedError,
  ProviderUnavailableError,
  RateLimitedError,
  type SpendReservation,
} from "@reranker/jobs";
import { cost } from "@reranker/schema";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { delay } from "msw/utils/delay";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { costOf } from "../src/generate/config";
import {
  PARAPHRASE_PROMPT_V1_EN,
  PARAPHRASE_PROMPT_V1_PT,
} from "../src/generate/prompts/paraphrase.v1";
import { type DraftIntent, embed, generateParaphrases, judge } from "../src/generate/providers";
import { MeasurementLanguageError } from "../src/language";

const RESERVED = cost(9000, "USD");

const jobs = vi.hoisted(() => ({
  release: vi.fn(async () => {}),
  acquireProviderSlot: vi.fn(),
  reserveSpend: vi.fn(),
  settleSpend: vi.fn(async () => ({ applied: true })),
  releaseSpend: vi.fn(async () => ({ applied: true })),
  breakerRecord: vi.fn(async () => {}),
  loadJobsConfig: vi.fn(() => ({
    limits: { openai: { maxInFlight: 8 }, gemini: { maxInFlight: 8 } },
  })),
}));

vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  ...jobs,
}));

const RESPONSES = "https://api.openai.com/v1/responses";
const EMBEDDINGS = "https://api.openai.com/v1/embeddings";
const INTERACTIONS = "https://generativelanguage.googleapis.com/v1/interactions";

const bakery: DraftIntent = {
  category: {
    key: "gen:places:bakery",
    source: "places_type",
    label: "Panadería",
    noun: "panadería",
    archetype: "food",
    scope: "local",
    register: "tu",
    placesTypes: ["bakery"],
  },
  scope: "local",
  kind: "discovery",
  slug: "discovery",
  canonicalText: "¿Qué panadería me recomiendas en {lugar}?",
  language: "es",
  noun: "panadería",
  registerProfile: "co",
};

const spend = { purpose: "contract-test" as const, refType: "test", refId: "ref-1" };
const ctx = () => ({ spend, signal: AbortSignal.timeout(5000), deadlineAt: Date.now() + 5000 });

const FORMATS = ["open_question", "list_request", "keyword", "constraint"] as const;
const paraphrases = Array.from({ length: 12 }, (_, i) => ({
  text: `¿Qué panadería ${i} me recomiendas en {lugar}?`,
  format: FORMATS[i % 4] ?? "keyword",
}));

const openaiUsage = {
  input_tokens: 900,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens: 400,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 1300,
};

const openaiResponse = (content: Record<string, unknown>, status = "completed") => ({
  id: "resp_1",
  object: "response",
  status,
  model: "gpt-6.1-terra-2026-10-15",
  incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
  output: [
    { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [content] },
  ],
  usage: openaiUsage,
});
const outputText = (value: unknown) => ({
  type: "output_text",
  annotations: [],
  text: JSON.stringify(value),
});

function respond(url: string, reply: () => Response | Promise<Response>) {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.post(url, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return reply();
    }),
  );
  return bodies;
}

beforeAll(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("OPENAI_API_KEY", "sk-unit");
  vi.stubEnv("GEMINI_API_KEY", "gemini-unit");
  server.listen();
  jobs.acquireProviderSlot.mockImplementation(async () => ({ release: jobs.release }));
  jobs.reserveSpend.mockImplementation(
    async (): Promise<SpendReservation> => ({
      id: "00000000-0000-4000-8000-000000000001",
      reserved: RESERVED,
      provider: "openai",
      purpose: "contract-test",
      scopes: [],
    }),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});

test("openai paraphrases parse the structured output and settle the measured cost", async () => {
  const bodies = respond(RESPONSES, () =>
    HttpResponse.json(openaiResponse(outputText({ paraphrases }))),
  );
  const out = await generateParaphrases(
    "openai",
    { intent: bakery, register: "co", withPersonas: false },
    ctx(),
  );

  expect(out.paraphrases).toHaveLength(12);
  expect(out.paraphrases[0]).toEqual({ ...paraphrases[0], generator: "openai" });
  expect(out.personas).toEqual([]);
  expect(bodies[0]).toMatchObject({
    model: "gpt-6.1-terra",
    store: false,
    text: { format: { name: "paraphrases" } },
  });
  expect(JSON.stringify(bodies[0])).toContain("panadería");
  const [, , options] = jobs.acquireProviderSlot.mock.calls[0] as unknown as [
    string,
    unknown,
    { maxWaitMs: number },
  ];
  expect(options.maxWaitMs).toBeLessThanOrEqual(5000);
  expect(jobs.settleSpend).toHaveBeenCalledWith(
    expect.objectContaining({ reserved: RESERVED }),
    costOf("gpt-6.1-terra", {
      inputTokens: 900,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 400,
    }),
  );
  expect(jobs.reserveSpend).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "openai", ...spend }),
  );
  expect(jobs.releaseSpend).not.toHaveBeenCalled();
  expect(jobs.release).toHaveBeenCalledTimes(1);
});

test("gemini returns paraphrases and personas, billing thinking as output", async () => {
  const personas = [
    "Trabajo hasta tarde y tengo dos hijos pequeños.",
    "Me gusta el pan artesanal.",
    "Organizo desayunos para mi oficina.",
  ];
  const bodies = respond(INTERACTIONS, () =>
    HttpResponse.json({
      id: "v1_1",
      object: "interaction",
      model: "gemini-3.8-flash",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [{ type: "text", text: JSON.stringify({ paraphrases, personas }) }],
        },
      ],
      usage: {
        total_input_tokens: 1000,
        total_cached_tokens: 0,
        total_output_tokens: 500,
        total_thought_tokens: 200,
      },
    }),
  );
  const out = await generateParaphrases(
    "gemini",
    { intent: bakery, register: "co", withPersonas: true },
    ctx(),
  );

  expect(out.paraphrases.every((p) => p.generator === "gemini")).toBe(true);
  expect(out.personas).toEqual(personas);
  expect(bodies[0]).toMatchObject({
    model: "gemini-3.8-flash",
    store: false,
    generation_config: { thinking_level: "low" },
  });
  expect(jobs.settleSpend).toHaveBeenCalledWith(
    expect.anything(),
    costOf("gemini-3.8-flash", {
      inputTokens: 1000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 700,
    }),
  );
});

test("a signal aborted before sending takes no slot and reserves nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    generateParaphrases(
      "openai",
      { intent: bakery, register: "co", withPersonas: false },
      { ...ctx(), signal: controller.signal },
    ),
  ).rejects.toThrow();
  expect(jobs.acquireProviderSlot).not.toHaveBeenCalled();
  expect(jobs.reserveSpend).not.toHaveBeenCalled();
});

test("an abort in flight settles the reservation, which may have been billed, and frees the slot", async () => {
  respond(RESPONSES, async () => {
    await delay(2000);
    return HttpResponse.json(openaiResponse(outputText({ paraphrases })));
  });
  const run = generateParaphrases(
    "openai",
    { intent: bakery, register: "co", withPersonas: false },
    { ...ctx(), signal: AbortSignal.timeout(50) },
  );
  await expect(run).rejects.toBeInstanceOf(ProviderUnavailableError);
  expect(jobs.settleSpend).toHaveBeenCalledWith(expect.anything(), RESERVED);
  expect(jobs.releaseSpend).not.toHaveBeenCalled();
  expect(jobs.release).toHaveBeenCalledTimes(1);
});

test.each([
  ["a refusal", openaiResponse({ type: "refusal", refusal: "No puedo ayudar con eso." })],
  ["invalid JSON", openaiResponse({ type: "output_text", annotations: [], text: "{not json" })],
  ["a truncated answer", openaiResponse(outputText({ paraphrases: [] }), "incomplete")],
])("%s returns no paraphrases instead of throwing and settles what it cost", async (_, body) => {
  respond(RESPONSES, () => HttpResponse.json(body));
  const out = await generateParaphrases(
    "openai",
    { intent: bakery, register: "co", withPersonas: true },
    ctx(),
  );
  expect(out).toEqual({ paraphrases: [], personas: [] });
  expect(jobs.settleSpend).toHaveBeenCalledWith(
    expect.anything(),
    costOf("gpt-6.1-terra", {
      inputTokens: 900,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 400,
    }),
  );
});

test("a rate limit releases the reservation; an outage settles it and trips the breaker", async () => {
  respond(RESPONSES, () =>
    HttpResponse.json(
      { error: { code: "rate_limit_exceeded" } },
      { status: 429, headers: { "retry-after": "2" } },
    ),
  );
  await expect(
    generateParaphrases("openai", { intent: bakery, register: "co", withPersonas: false }, ctx()),
  ).rejects.toBeInstanceOf(RateLimitedError);
  expect(jobs.releaseSpend).toHaveBeenCalledTimes(1);

  respond(INTERACTIONS, () =>
    HttpResponse.json({ error: { code: "unavailable" } }, { status: 503 }),
  );
  await expect(
    generateParaphrases("gemini", { intent: bakery, register: "co", withPersonas: false }, ctx()),
  ).rejects.toBeInstanceOf(ProviderUnavailableError);
  expect(jobs.settleSpend).toHaveBeenCalledWith(expect.anything(), RESERVED);
  expect(jobs.breakerRecord).toHaveBeenCalledWith("gemini", "failure");
  expect(jobs.release).toHaveBeenCalledTimes(2);
});

test("embed returns one vector per text in input order and settles the tokens", async () => {
  const bodies = respond(EMBEDDINGS, () =>
    HttpResponse.json({
      object: "list",
      model: "text-embedding-3-small",
      data: [
        { object: "embedding", index: 1, embedding: [0, 1] },
        { object: "embedding", index: 0, embedding: [1, 0] },
      ],
      usage: { prompt_tokens: 30, total_tokens: 30 },
    }),
  );
  const vectors = await embed(["uno", "dos"], ctx());
  expect(vectors).toEqual([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
  expect(bodies[0]).toMatchObject({
    model: "text-embedding-3-small",
    input: ["uno", "dos"],
    encoding_format: "float",
  });
  expect(jobs.settleSpend).toHaveBeenCalledWith(expect.anything(), cost(1, "USD"));
  expect(await embed([], ctx())).toEqual([]);
  expect(jobs.reserveSpend).toHaveBeenCalledTimes(1);
});

test("judge returns one verdict per candidate, false where the judge said nothing", async () => {
  const candidates = paraphrases.slice(0, 3).map((p) => ({ ...p, generator: "openai" as const }));
  const bodies = respond(RESPONSES, () =>
    HttpResponse.json(
      openaiResponse(
        outputText({
          verdicts: [
            { id: 2, keep: true },
            { id: 0, keep: true },
            { id: 7, keep: true },
          ],
        }),
      ),
    ),
  );
  expect(await judge(bakery, candidates, ctx())).toEqual([true, false, true]);
  expect(bodies[0]).toMatchObject({
    model: "gpt-6.1-terra",
    reasoning: { effort: "low" },
    text: { format: { name: "verdicts" } },
  });

  respond(RESPONSES, () => HttpResponse.json(openaiResponse({ type: "refusal", refusal: "No." })));
  expect(await judge(bakery, candidates, ctx())).toEqual([false, false, false]);
  expect(await judge(bakery, [], ctx())).toEqual([]);
});

test("billing errors and other rejections release the reservation without retrying", async () => {
  const req = { intent: bakery, register: "co", withPersonas: false } as const;
  respond(RESPONSES, () =>
    HttpResponse.json({ error: { code: "insufficient_quota" } }, { status: 429 }),
  );
  await expect(generateParaphrases("openai", req, ctx())).rejects.toBeInstanceOf(
    ProviderRejectedError,
  );

  respond(INTERACTIONS, () =>
    HttpResponse.json(
      { error: { code: "rate_limited" } },
      { status: 429, headers: { "retry-after-ms": "250" } },
    ),
  );
  await expect(generateParaphrases("gemini", req, ctx())).rejects.toMatchObject({
    retryAfterMs: 250,
  });
  respond(INTERACTIONS, () =>
    HttpResponse.json({ error: { code: "invalid_argument" } }, { status: 400 }),
  );
  await expect(generateParaphrases("gemini", req, ctx())).rejects.toBeInstanceOf(
    ProviderRejectedError,
  );

  expect(jobs.releaseSpend).toHaveBeenCalledTimes(3);
  expect(jobs.settleSpend).not.toHaveBeenCalled();
  expect(jobs.breakerRecord).not.toHaveBeenCalledWith(expect.anything(), "failure");
});

test("a blocked gemini answer yields nothing and settles its usage", async () => {
  respond(INTERACTIONS, () =>
    HttpResponse.json({
      id: "v1_2",
      object: "interaction",
      model: "gemini-3.8-flash",
      status: "failed",
      errors: [{ code: "safety" }],
      usage: { total_input_tokens: 800, total_output_tokens: 0 },
    }),
  );
  const out = await generateParaphrases(
    "gemini",
    { intent: bakery, register: "neutral", withPersonas: true },
    ctx(),
  );
  expect(out).toEqual({ paraphrases: [], personas: [] });
  expect(jobs.settleSpend).toHaveBeenCalledWith(
    expect.anything(),
    costOf("gemini-3.8-flash", {
      inputTokens: 800,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    }),
  );
});

test("an answer without usage settles the full reservation", async () => {
  respond(RESPONSES, () =>
    HttpResponse.json({ ...openaiResponse(outputText({ paraphrases })), usage: undefined }),
  );
  const out = await generateParaphrases(
    "openai",
    { intent: bakery, register: "co", withPersonas: false },
    ctx(),
  );
  expect(out.paraphrases).toEqual([]);
  expect(jobs.settleSpend).toHaveBeenCalledWith(expect.anything(), RESERVED);
});

test("embeddings that do not match the input are billed and rejected", async () => {
  respond(EMBEDDINGS, () =>
    HttpResponse.json({
      object: "list",
      model: "text-embedding-3-small",
      data: [{ object: "embedding", index: 0, embedding: [1, 0] }],
      usage: { prompt_tokens: 30, total_tokens: 30 },
    }),
  );
  await expect(embed(["uno", "dos"], ctx())).rejects.toThrow("invalid_output");
  expect(jobs.settleSpend).toHaveBeenCalledWith(expect.anything(), cost(1, "USD"));
});

test("an English intent is asked with the English prompts and no form of address", async () => {
  const bodies = respond(RESPONSES, () =>
    HttpResponse.json(openaiResponse(outputText({ paraphrases }))),
  );
  const intent: DraftIntent = {
    ...bakery,
    category: { ...bakery.category, label: "Bakery", noun: "bakery" },
    noun: "bakery",
    canonicalText: "What bakery do you recommend in {lugar}?",
    language: "en",
    registerProfile: "neutral",
  };
  await generateParaphrases("openai", { intent, register: "neutral", withPersonas: false }, ctx());

  expect(bodies[0]?.instructions).toBe(PARAPHRASE_PROMPT_V1_EN);
  const payload = JSON.parse(String(bodies[0]?.input));
  expect(payload).toMatchObject({ noun: "bakery", variety: expect.stringContaining("English") });
  expect(payload).not.toHaveProperty("address");
});

test("a language without reviewed prompts is refused before any slot, reservation or call", async () => {
  const bodies = respond(RESPONSES, () => HttpResponse.json({}));
  const intent = { ...bakery, language: "fr" } as unknown as DraftIntent;
  const refused = expect.objectContaining({ language: "fr", gap: "no_prompts" });

  await expect(
    generateParaphrases("openai", { intent, register: "neutral", withPersonas: true }, ctx()),
  ).rejects.toEqual(refused);
  await expect(judge(intent, [], ctx())).rejects.toEqual(refused);
  await expect(
    judge(intent, [{ text: "x", format: "keyword", generator: "openai" }], ctx()),
  ).rejects.toBeInstanceOf(MeasurementLanguageError);
  expect(bodies).toHaveLength(0);
  expect(jobs.acquireProviderSlot).not.toHaveBeenCalled();
  expect(jobs.reserveSpend).not.toHaveBeenCalled();
});

test("a Portuguese intent is asked with the Portuguese prompts, addressing people as você", async () => {
  const bodies = respond(RESPONSES, () =>
    HttpResponse.json(openaiResponse(outputText({ paraphrases }))),
  );
  const intent: DraftIntent = {
    ...bakery,
    category: { ...bakery.category, label: "Padaria", noun: "padaria" },
    noun: { text: "padaria", gender: "f" },
    canonicalText: "Qual padaria você recomenda em {lugar}?",
    language: "pt",
    registerProfile: "neutral",
  };
  await generateParaphrases("openai", { intent, register: "neutral", withPersonas: false }, ctx());

  expect(bodies[0]?.instructions).toBe(PARAPHRASE_PROMPT_V1_PT);
  const payload = JSON.parse(String(bodies[0]?.input));
  expect(payload).toMatchObject({
    noun: "padaria",
    address: "você",
    variety: expect.stringContaining("português do Brasil"),
  });
});

test("a gendered language without the noun's gender is refused before any slot or call", async () => {
  const bodies = respond(RESPONSES, () => HttpResponse.json({}));
  const intent = { ...bakery, language: "pt", noun: "padaria" } as unknown as DraftIntent;
  const refused = expect.objectContaining({ language: "pt", gap: "no_noun_gender" });

  await expect(
    generateParaphrases("openai", { intent, register: "neutral", withPersonas: false }, ctx()),
  ).rejects.toEqual(refused);
  await expect(judge(intent, [], ctx())).rejects.toEqual(refused);
  expect(bodies).toHaveLength(0);
  expect(jobs.acquireProviderSlot).not.toHaveBeenCalled();
});
