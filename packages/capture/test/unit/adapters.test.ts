import { beforeEach, expect, test, vi } from "vitest";
import type { CaptureAdapter } from "../../src/adapters";

// The registry is module state: each test gets a fresh one.
beforeEach(() => {
  vi.resetModules();
});

const load = async () => ({
  ...(await import("../../src/adapters")),
  ...(await import("@reranker/jobs/errors")),
});

const adapter = (provider: CaptureAdapter["provider"]): CaptureAdapter => ({
  provider,
  channel: provider === "openai" ? "api" : "ui-vendor",
  captureLive: () => Promise.reject(new Error("not called")),
});

test("a provider without adapter is invalid input", async () => {
  const { adapterFor, InvalidInputError } = await load();
  expect(() => adapterFor("brightdata")).toThrow(InvalidInputError);
});

test("a registered adapter is found by its provider", async () => {
  const { adapterFor, registerCaptureAdapter, InvalidInputError } = await load();
  const openai = adapter("openai");
  registerCaptureAdapter(openai);
  expect(adapterFor("openai")).toBe(openai);
  expect(() => adapterFor("dataforseo")).toThrow(InvalidInputError);
});

test("registering the same adapter twice is harmless; a second one for the provider is refused", async () => {
  const { adapterFor, registerCaptureAdapter, InvalidInputError } = await load();
  const first = adapter("dataforseo");
  registerCaptureAdapter(first);
  registerCaptureAdapter(first);
  expect(() => registerCaptureAdapter(adapter("dataforseo"))).toThrow(InvalidInputError);
  expect(adapterFor("dataforseo")).toBe(first);
});
