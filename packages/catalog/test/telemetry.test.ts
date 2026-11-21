import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cost } from "@reranker/schema";
import type { IntentSet, MeasurementLanguage } from "@reranker/schema/measurement";
import { opsAlerts } from "@reranker/telemetry";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// An in-memory stand-in for the ten-minute window that ops.record_velocity keeps in Postgres.
const windows = new Map<string, { count10m: number; flagged10m: number }>();
const velocity = vi.hoisted(() => ({ recordVelocities: vi.fn() }));
vi.mock("@reranker/jobs/velocity", () => velocity);

const telemetry = vi.hoisted(() => ({
  captureServerEvent: vi.fn(),
  sendOpsAlert: vi.fn(async (_kind: string, _payload?: Record<string, unknown>) => {}),
  runAfter: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@reranker/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/telemetry")>()),
  ...telemetry,
}));

const { recordIntentSetResolution } = await import("../src/telemetry");
type Resolution = Parameters<typeof recordIntentSetResolution>[0];

const pending: Promise<void>[] = [];

beforeEach(() => {
  windows.clear();
  velocity.recordVelocities.mockImplementation(
    async (samples: { key: string; flagged: boolean }[]) =>
      samples.map(({ key, flagged }) => {
        const w = windows.get(key) ?? { count10m: 0, flagged10m: 0 };
        const next = { count10m: w.count10m + 1, flagged10m: w.flagged10m + (flagged ? 1 : 0) };
        windows.set(key, next);
        return { ...next, spend10m: cost(0, "USD"), spend60m: cost(0, "USD") };
      }),
  );
  telemetry.runAfter.mockImplementation((fn: () => Promise<void>) => {
    pending.push(fn());
  });
});

afterEach(() => {
  vi.clearAllMocks();
  pending.length = 0;
});

const set = (kind: IntentSet["manifest"]["kind"]) =>
  ({
    manifest: { id: "is_0123456789abcdef", kind, categoryKey: "gen:places:bakery" },
  }) as unknown as IntentSet;

const resolution = (over: Partial<Resolution> = {}): Resolution => ({
  set: set(over.outcome === "template" ? "template" : "generated"),
  outcome: "generated",
  language: "es",
  geoLevel: "city",
  fallback: null,
  generationMs: 6400,
  costMicros: 41_000,
  generators: 2,
  guardRejects: 7,
  judgeRejects: 3,
  ...over,
});

async function record(resolutions: Resolution[]) {
  for (const r of resolutions) {
    recordIntentSetResolution(r);
    while (pending.length > 0) await pending.shift();
  }
}

const many = (n: number, over: Partial<Resolution>) =>
  Array.from({ length: n }, () => resolution(over));
const template = (language: MeasurementLanguage = "es") =>
  resolution({ outcome: "template", fallback: "incomplete", language, generators: 0 });
const alerts = () =>
  telemetry.sendOpsAlert.mock.calls.filter(([kind]) => kind === "intent-generation-template-rate");

test("each resolution emits one event with its outcome and language", async () => {
  await record([
    resolution({ outcome: "seed", set: set("seed"), generationMs: 0, costMicros: 0 }),
    resolution({ outcome: "reused", generationMs: 0, costMicros: 0 }),
    resolution(),
    template("pt"),
  ]);
  const events = telemetry.captureServerEvent.mock.calls.map(([event]) => event);
  expect(events.map((e) => [e.props.outcome, e.props.language])).toEqual([
    ["seed", "es"],
    ["reused", "es"],
    ["generated", "es"],
    ["template", "pt"],
  ]);
  expect(events[2]).toEqual({
    name: "intent_set_resolved",
    props: {
      outcome: "generated",
      language: "es",
      fallback: null,
      category_key: "gen:places:bakery",
      generation_ms: 6400,
      cost_micros: 41_000,
      generators: 2,
      guard_rejects: 7,
      judge_rejects: 3,
    },
  });
  expect(events[3]?.props.fallback).toBe("incomplete");
  expect(telemetry.log.info).toHaveBeenCalledWith(
    "catalog.intent_set.resolved",
    expect.objectContaining({
      intent_set_id: "is_0123456789abcdef",
      intent_set_kind: "generated",
      geo_level: "city",
      language: "es",
    }),
  );
});

test("seeds and reused sets never touch the alert windows", async () => {
  await record([
    resolution({ outcome: "seed", set: set("seed") }),
    resolution({ outcome: "reused" }),
  ]);
  expect(velocity.recordVelocities).not.toHaveBeenCalled();
});

test("template rate above 10% with 20 or more attempts alerts once", async () => {
  await record([...many(18, {}), template(), template(), template(), template()]);
  expect(alerts()).toEqual([
    ["intent-generation-template-rate", { language: "es", attempts_10m: 21, templates_10m: 3 }],
  ]);
});

test("a regression in one language alerts with that language while the rest stay healthy", async () => {
  await record([...many(40, { language: "es" }), ...many(18, { language: "pt" })]);
  await record([template("pt"), template("pt"), template("pt")]);
  expect(alerts()).toEqual([
    ["intent-generation-template-rate", { language: "pt", attempts_10m: 21, templates_10m: 3 }],
  ]);
});

test("templates spread thin across languages still alert on the overall rate", async () => {
  const languages: MeasurementLanguage[] = ["es", "en", "pt", "fr", "de", "it"];
  await record(languages.flatMap((language) => many(3, { language })));
  await record(languages.slice(0, 3).map((language) => template(language)));
  expect(alerts()).toEqual([
    ["intent-generation-template-rate", { language: "all", attempts_10m: 21, templates_10m: 3 }],
  ]);
});

test("the kill switch, languages without prompts and shared templates are not counted", async () => {
  await record([
    ...many(20, {}),
    ...many(10, { outcome: "template", fallback: "disabled" }),
    ...many(10, { outcome: "template", fallback: "no_prompts" }),
    ...many(10, { outcome: "template", fallback: "shared" }),
  ]);
  expect(alerts()).toEqual([]);
  expect(windows.get("catalog:template-rate")).toEqual({ count10m: 20, flagged10m: 0 });
});

test("a failing window write is logged and never thrown", async () => {
  velocity.recordVelocities.mockRejectedValueOnce(new Error("pool exhausted"));
  await expect(record([resolution()])).resolves.toBeUndefined();
  expect(telemetry.log.warn).toHaveBeenCalledWith("catalog.velocity_failed", { error: "Error" });
});

test("the alert kind has a runbook", () => {
  const runbook = opsAlerts["intent-generation-template-rate"].runbook;
  const root = fileURLToPath(new URL("../../../docs/runbooks/", import.meta.url));
  expect(existsSync(`${root}${runbook}`)).toBe(true);
});
