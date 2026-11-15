import { readFileSync } from "node:fs";
import { CaptureChannel, CaptureProvider, EngineId } from "@reranker/schema";
import { expect, test } from "vitest";
import data from "../registry.json" with { type: "json" };
import { renderFlagKeys } from "../scripts/gen";
import { FLAG_KEYS, KILL_SWITCH_KEYS } from "./flag-keys.gen";
import { parseRegistry, registry } from "./registry";

test("flag-keys.gen.ts is what flags:gen renders from registry.json", () => {
  const generated = readFileSync(new URL("./flag-keys.gen.ts", import.meta.url), "utf8");
  expect(generated).toBe(renderFlagKeys(data));
  expect(FLAG_KEYS).toEqual(registry.map((f) => f.key));
  expect(KILL_SWITCH_KEYS).toEqual(
    registry.filter((f) => f.kind === "kill-switch").map((f) => f.key),
  );
});

test("keys are unique and kebab-case", () => {
  const keys = registry.map((f) => f.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const key of keys) expect(key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test("every release flag carries an ISO expiry date", () => {
  for (const flag of registry.filter((f) => f.kind === "release")) {
    expect(flag.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${flag.expires}T00:00:00Z`).toISOString().slice(0, 10)).toBe(flag.expires);
  }
});

test("every capture channel, provider and engine has its kill switch", () => {
  const expected = [
    ...CaptureChannel.options.map((c) => `capture-channel-${c}`),
    ...CaptureProvider.options.map((p) => `capture-provider-${p}`),
    ...EngineId.options.map((e) => `capture-engine-${e}`),
  ];
  for (const key of expected) expect(KILL_SWITCH_KEYS).toContain(key);
});

test("paid providers are production-only", () => {
  const productionOnly = registry.filter((f) => f.productionOnly).map((f) => f.key);
  expect(productionOnly.sort()).toEqual(
    [
      "capture-provider-dataforseo",
      "capture-provider-openai",
      "capture-provider-brightdata",
      "intent-generation",
      "places-resolution",
      "extraction-secondary",
    ].sort(),
  );
});

test("rejects a release without expiry, an unknown kind and a key that was never generated", () => {
  const base = { owner: "test", description: "x" };
  expect(() => parseRegistry([{ ...base, key: "accounts", kind: "release" }])).toThrow();
  expect(() => parseRegistry([{ ...base, key: "accounts", kind: "toggle" }])).toThrow();
  expect(() => parseRegistry([{ ...base, key: "not-generated", kind: "kill-switch" }])).toThrow();
  expect(() =>
    parseRegistry([{ ...base, key: "accounts", kind: "release", expires: "2027-02-30" }]),
  ).toThrow();
  expect(parseRegistry([{ ...base, key: "accounts", kind: "kill-switch" }])).toHaveLength(1);
});
