import { readFileSync } from "node:fs";
import { InvalidInputError } from "@reranker/jobs/errors";
import type { EngineId } from "@reranker/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { dataforseoAdapter } from "../../src/dataforseo/adapter";
import { captureLive } from "../../src/dataforseo/live";
import { parseAiMode } from "../../src/dataforseo/parse/ai-mode";
import { parseAiOverview } from "../../src/dataforseo/parse/ai-overview";
import { parseChatGpt } from "../../src/dataforseo/parse/chatgpt";
import { parseGemini } from "../../src/dataforseo/parse/gemini";
import type { FrozenSlot } from "../../src/slot";

vi.mock("../../src/dataforseo/live", () => ({ captureLive: vi.fn(async () => ({})) }));

const fixture = (path: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/${path}`, import.meta.url)));
const slot = (engine: EngineId) => ({ engine }) as FrozenSlot;

beforeEach(() => vi.mocked(captureLive).mockClear());

test.each([
  ["chatgpt", parseChatGpt],
  ["gemini", parseGemini],
  ["google-ai-overview", parseAiOverview],
  ["google-ai-mode", parseAiMode],
] as const)("%s is called Live and read by its own parser", async (engine, parser) => {
  await dataforseoAdapter.captureLive(slot(engine));
  expect(captureLive).toHaveBeenCalledExactlyOnceWith(slot(engine), parser);
});

test("Perplexity is refused before any call", async () => {
  await expect(dataforseoAdapter.captureLive(slot("perplexity"))).rejects.toBeInstanceOf(
    InvalidInputError,
  );
  expect(captureLive).not.toHaveBeenCalled();
});

test("captures are recorded as UI-vendor DataForSEO calls", () =>
  expect(dataforseoAdapter).toMatchObject({ provider: "dataforseo", channel: "ui-vendor" }));

test("re-derivation reads each engine's bytes with that engine's current parser", () => {
  const bytes = fixture("recorded/live/ai-mode-dentistas-medellin.json");
  expect(dataforseoAdapter.parse?.("google-ai-mode", bytes)).toEqual(parseAiMode(bytes));
  expect(() => dataforseoAdapter.parse?.("perplexity", bytes)).toThrow(InvalidInputError);
});
