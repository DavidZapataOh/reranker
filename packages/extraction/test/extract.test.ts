import type { EngineAnswer } from "@reranker/capture";
import { ProviderUnavailableError, type SpendReservation } from "@reranker/jobs";
import { cost } from "@reranker/schema";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { currentExtractorConfig, type ExtractorConfig } from "../src/config";
import { extractResponse, type RawCapture } from "../src/extract";
import { costOfUsage } from "../src/prices";
import { JUDGE_PROMPT_V3 } from "../src/prompts/judge.v3";
import { ProviderRefusalError, type StructuredResult } from "../src/providers/types";
import type { MentionsOutput } from "../src/schema";

const doubles = vi.hoisted(() => ({
  openai: vi.fn(),
  gemini: vi.fn(),
  isEnabled: vi.fn(async () => true),
  artifacts: new Map<string, Uint8Array>(),
  rows: new Map<string, { id: string; outputsSha256: string }>(),
  settleSpend: vi.fn(async () => ({ applied: true })),
}));

vi.mock("../src/providers/openai", () => ({ callOpenAI: doubles.openai }));
vi.mock("../src/providers/gemini", () => ({ callGemini: doubles.gemini }));
vi.mock("@reranker/flags", () => ({ isEnabled: doubles.isEnabled }));
vi.mock("@reranker/evidence", async () => {
  const { createHash } = await import("node:crypto");
  return {
    putArtifact: vi.fn(async (_kind: string, bytes: Uint8Array) => {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      doubles.artifacts.set(sha256, bytes);
      return { sha256, created: true };
    }),
    getArtifact: vi.fn(async (_kind: string, sha: string) => doubles.artifacts.get(sha) ?? null),
  };
});
vi.mock("../src/store", () => ({
  findExtraction: vi.fn(async (captureId: string) => doubles.rows.get(captureId) ?? null),
  insertExtraction: vi.fn(async (row: { captureId: string; outputsSha256: string }) => {
    const existing = doubles.rows.get(row.captureId);
    if (existing) return { id: existing.id, inserted: false };
    doubles.rows.set(row.captureId, {
      id: `ext-${row.captureId}`,
      outputsSha256: row.outputsSha256,
    });
    return { id: `ext-${row.captureId}`, inserted: true };
  }),
}));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  loadJobsConfig: () => ({ limits: { openai: { maxInFlight: 8 }, gemini: { maxInFlight: 8 } } }),
  acquireProviderSlot: async () => ({ release: async () => {} }),
  reserveSpend: async (): Promise<SpendReservation> => ({
    id: "00000000-0000-4000-8000-000000000001",
    reserved: cost(50_000, "USD"),
    provider: "openai",
    purpose: "contract-test",
    scopes: [],
  }),
  settleSpend: doubles.settleSpend,
  releaseSpend: async () => ({ applied: true }),
}));

const markdown =
  "Te recomiendo **Clínica Sonrisa** en Laureles. También está Clínica Brillo. Reserva en Doctoralia.";
const spend = { purpose: "contract-test" as const, refType: "test", refId: "ref-1" };
const ctx = { spend };

const usage = (outputTokens: number) => ({
  inputTokens: 1500,
  cachedInputTokens: 1000,
  cacheWriteTokens: 0,
  outputTokens,
});

type Item = [name: string, stance: MentionsOutput["mentions"][number]["stance"]];
const out = (...items: Item[]): MentionsOutput => ({
  answerKind: items.length ? "names_entities" : "no_entities",
  mentions: items.map(([name, stance]) => ({
    name,
    quote: name,
    stance,
    entityKind: name === "Doctoralia" ? "other" : "business",
    sentiment: "neutral",
    locationHint: null,
    citedUrls: [],
  })),
});
const reply =
  (output: MentionsOutput, model: string, tokens = 300) =>
  async (): Promise<StructuredResult<MentionsOutput>> => ({
    output,
    modelReported: model,
    usage: usage(tokens),
    raw: {},
  });

const AGREED = out(["Clínica Sonrisa", "recommendation"], ["Doctoralia", "incidental"]);

let seq = 0;
function capture(
  answer: Partial<EngineAnswer> | null,
  status: RawCapture["capture"]["status"] = "succeeded",
): RawCapture {
  seq += 1;
  return {
    capture: {
      id: `cap_${seq}`,
      engine: "chatgpt",
      channel: "ui-vendor",
      status,
      modelReported: null,
      slotId: `slot-${seq}`,
    },
    answer: answer && ({ present: true, markdown, ...answer } as EngineAnswer),
  };
}

beforeEach(() => {
  vi.stubEnv("ENTITY_NAME_HMAC_KEY", Buffer.alloc(32, 7).toString("base64url"));
  doubles.openai.mockImplementation(reply(AGREED, "gpt-6-luna-2026-10-01"));
  doubles.gemini.mockImplementation(reply(AGREED, "gemini-3.1-flash-lite-001"));
});
afterEach(() => {
  vi.resetAllMocks();
  doubles.isEnabled.mockImplementation(async () => true);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test("a failed capture yields capture_failed without any LLM call", async () => {
  const r = await extractResponse(capture(null, "timeout"), ctx);
  expect(r).toMatchObject({ answerKind: "capture_failed", mentions: [], agreement: "single" });
  expect(doubles.openai).not.toHaveBeenCalled();
});

test.each([
  ["an absent surface", { present: false, markdown: "" }],
  ["a blank answer", { present: true, markdown: " \n" }],
])("%s yields no_entities without any LLM call", async (_, answer) => {
  const r = await extractResponse(capture(answer), ctx);
  expect(r.answerKind).toBe("no_entities");
  expect(doubles.openai).not.toHaveBeenCalled();
});

test("a succeeded capture without its answer is a broken invariant, not an empty answer", async () => {
  await expect(extractResponse(capture(null), ctx)).rejects.toThrow(/without an answer/);
});

test("agreeing extractors run in parallel and tag platforms from the config's registry", async () => {
  // The primary only answers once the secondary has started, so a sequential run would hang.
  const secondaryStarted = Promise.withResolvers<void>();
  doubles.openai.mockImplementation(async () => {
    await secondaryStarted.promise;
    return reply(AGREED, "gpt-6-luna-2026-10-01")();
  });
  doubles.gemini.mockImplementation(async () => {
    secondaryStarted.resolve();
    return reply(AGREED, "gemini-3.1-flash-lite-001")();
  });
  const r = await extractResponse(capture({}), ctx);
  expect(r).toMatchObject({
    answerKind: "names_entities",
    agreement: "agreed",
    models: {
      primary: "gpt-6-luna-2026-10-01",
      secondary: "gemini-3.1-flash-lite-001",
      judge: null,
    },
  });
  expect(r.mentions.map((m) => [m.entityKey, m.ordinal, m.resolution.status])).toEqual([
    ["name:clinica sonrisa", 1, "not_attempted"],
    ["platform:doctoralia", null, "platform"],
  ]);
  expect(markdown.slice(r.mentions[0]?.startOffset, r.mentions[0]?.endOffset)).toBe(
    "Clínica Sonrisa",
  );
});

test("a config without a registry entry leaves the platform untagged", async () => {
  const config: ExtractorConfig = { ...currentExtractorConfig, platforms: [] };
  const r = await extractResponse(capture({}), ctx, { config });
  expect(r.mentions[1]).toMatchObject({ entityKind: "other", entityKey: "name:doctoralia" });
});

test("secondary timeout falls back to single within 7 s", async () => {
  vi.useFakeTimers();
  doubles.gemini.mockImplementation(() => new Promise(() => {}));
  const p = extractResponse(capture({}), ctx);
  await vi.advanceTimersByTimeAsync(7000);
  const r = await p;
  expect(r).toMatchObject({ agreement: "single", models: { secondary: null } });
  // The timed-out secondary settled its reservation, so the cost carries it.
  expect(r.cost.amount_micros).toBe(costOfUsage("gpt-6-luna", usage(300)).amount_micros + 50_000);
});

test("extraction-secondary off runs the primary only", async () => {
  doubles.isEnabled.mockResolvedValue(false);
  const r = await extractResponse(capture({}), ctx);
  expect(doubles.isEnabled).toHaveBeenCalledWith("extraction-secondary", { kind: "system" });
  expect(doubles.gemini).not.toHaveBeenCalled();
  expect(r.agreement).toBe("single");
});

test("primary down after one retry throws ProviderUnavailable for the step to retry", async () => {
  vi.useFakeTimers();
  doubles.openai.mockRejectedValue(new ProviderUnavailableError("openai", 1000));
  const raw = capture({});
  const p = extractResponse(raw, ctx);
  const rejected = expect(p).rejects.toBeInstanceOf(ProviderUnavailableError);
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(doubles.openai).toHaveBeenCalledTimes(2);
  expect(doubles.rows.has(raw.capture.id)).toBe(false);
});

test("a refusal of the primary is answerKind refusal, not an exception", async () => {
  doubles.openai.mockRejectedValue(new ProviderRefusalError("openai", "no", usage(40)));
  const r = await extractResponse(capture({}), ctx);
  expect(r).toMatchObject({ answerKind: "refusal", mentions: [], agreement: "single" });
  expect(r.cost).toEqual(
    cost(
      costOfUsage("gpt-6-luna", usage(40)).amount_micros +
        costOfUsage("gemini-3.1-flash-lite", usage(300)).amount_micros,
      "USD",
    ),
  );
});

test("a disagreement calls the judge once and cost adds every call", async () => {
  doubles.gemini.mockImplementation(
    reply(out(["Clínica Sonrisa", "recommendation"], ["Clínica Brillo", "recommendation"]), "g"),
  );
  doubles.openai
    .mockImplementationOnce(reply(AGREED, "gpt-6-luna-2026-10-01", 300))
    .mockImplementationOnce(reply(out(["Clínica Brillo", "incidental"]), "gpt-6.1-terra", 900));
  const r = await extractResponse(capture({}), ctx);
  expect(doubles.openai).toHaveBeenCalledTimes(2);
  // The judge prompt names these fences, whatever language the answer is in.
  const judged = doubles.openai.mock.calls[1]?.[0];
  expect(judged?.system).toBe(JUDGE_PROMPT_V3);
  expect(judged?.user).toMatch(/^Answer:\n"""\n[\s\S]*\n"""\n\nDisagreement:\n\{/);
  expect(judged?.user).toContain('"onlySecondary"');
  expect(r).toMatchObject({ agreement: "adjudicated", models: { judge: "gpt-6.1-terra" } });
  expect(r.mentions.map((m) => m.name)).toEqual(["Clínica Sonrisa", "Clínica Brillo"]);
  expect(r.cost.amount_micros).toBe(
    costOfUsage("gpt-6-luna", usage(300)).amount_micros +
      costOfUsage("gemini-3.1-flash-lite", usage(300)).amount_micros +
      costOfUsage("gpt-6.1-terra", usage(900)).amount_micros,
  );
});

test("a failing judge rejects the extraction and stores nothing", async () => {
  const failure = new ProviderUnavailableError("openai", 1000);
  doubles.gemini.mockImplementation(reply(out(["Clínica Brillo", "recommendation"]), "g"));
  doubles.openai.mockImplementationOnce(reply(AGREED, "p")).mockRejectedValueOnce(failure);
  const raw = capture({});
  await expect(extractResponse(raw, ctx)).rejects.toBe(failure);
  expect(doubles.rows.has(raw.capture.id)).toBe(false);
});

test("only engine-listed names that neither extractor found reach the judge", async () => {
  const listed = capture({
    brandEntities: [
      { name: "Clínica Sonrisa", urls: [] },
      { name: "Marca Ausente", urls: [] },
    ],
  });
  await extractResponse(listed, ctx);
  expect(doubles.openai).toHaveBeenCalledTimes(1);

  doubles.openai
    .mockImplementationOnce(reply(AGREED, "p"))
    .mockImplementationOnce(reply(out(["Clínica Brillo", "recommendation"]), "j"));
  const hinted = capture({ localBusinesses: [{ name: "Clínica Brillo" }] });
  const r = await extractResponse(hinted, ctx);
  expect(doubles.openai.mock.calls.at(-1)?.[0].user).toContain('"recallHints":["Clínica Brillo"]');
  expect(r.agreement).toBe("adjudicated");
});

test("retrying after the row was written reads it back and spends nothing", async () => {
  const raw = capture({});
  const first = await extractResponse(raw, ctx);
  const second = await extractResponse(raw, ctx);
  expect(second).toEqual(first);
  expect(doubles.openai).toHaveBeenCalledTimes(1);
  expect(doubles.gemini).toHaveBeenCalledTimes(1);
});

test("a run that loses the insert race returns the stored extraction", async () => {
  const raw = capture({});
  const { findExtraction } = await import("../src/store");
  const first = await extractResponse(raw, ctx);
  vi.mocked(findExtraction).mockResolvedValueOnce(null);
  doubles.openai.mockImplementation(reply(out(["Clínica Brillo", "recommendation"]), "other"));
  const second = await extractResponse(raw, ctx);
  expect(second).toEqual(first);
});
