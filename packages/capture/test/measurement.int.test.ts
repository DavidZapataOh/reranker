import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { geoForEngine, getGeo, jcs, sha256Hex } from "@reranker/catalog";
import { endPools, withSystem } from "@reranker/db";
import { InvalidInputError, NotFoundError } from "@reranker/jobs/errors";
import type { EngineId } from "@reranker/schema";
import { PlannedObservation, type PlannedSlot } from "@reranker/schema/measurement";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loadSigner } from "../../evidence/src/signer";
import { previewEnv } from "../../evidence/test/support/evidence-env";
import { localSigner } from "../../evidence/test/support/local-signer";
import {
  createMeasurement,
  freezeMeasurementPlan,
  loadPlan,
  resetPlanCache,
} from "../src/measurement";

// Signing keys live in KMS; the evidence package's test signer stands in for them here.
vi.mock("../../evidence/src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));

const signer = localSigner("rr-capture-preview-1-ed25519");

// R2 is exercised by the evidence contract tests; here it is an in-memory bucket behind fetch,
// written once per key and served gunzipped, as the evidence client sees it.
const r2 = new Map<string, Uint8Array<ArrayBuffer>>();
let r2Down = false;
const objectKey = (url: string) => new URL(url).pathname.split("/").slice(2).join("/");

async function fakeR2(request: Request): Promise<Response> {
  if (r2Down) return new Response(null, { status: 503 });
  const key = objectKey(request.url);
  if (request.method === "PUT") {
    if (r2.has(key) && request.headers.get("if-none-match") === "*") {
      return new Response(null, { status: 412 });
    }
    r2.set(key, new Uint8Array(gunzipSync(new Uint8Array(await request.arrayBuffer()))));
    return new Response(null, { status: 200 });
  }
  const body = r2.get(key);
  return body ? new Response(body, { status: 200 }) : new Response(null, { status: 404 });
}

const MEDELLIN = "co-c1003654";
const ENGINES_CYCLE: EngineId[] = ["gemini", "google-ai-overview", "google-ai-mode"];

function plannedSlots(n: number, promptText = "¿Cuál es el mejor odontólogo en Medellín?") {
  return Array.from({ length: n }, (_, i): PlannedSlot => {
    const engine = ENGINES_CYCLE[i % ENGINES_CYCLE.length] as EngineId;
    const geoDeclared = geoForEngine(engine, getGeo(MEDELLIN), "local", {
      provider: "dataforseo",
    });
    if (!geoDeclared) throw new Error(`${engine} is not offered in ${MEDELLIN}`);
    return {
      engine,
      provider: "dataforseo",
      intentSetId: "is_0123456789abcdef",
      intentId: "dental_clinic.best",
      paraphraseId: `p${Math.floor(i / ENGINES_CYCLE.length) + 1}`,
      geoKey: MEDELLIN,
      geoDeclared,
      runIndex: 0,
      promptText,
    };
  });
}

// The package exports no package.json, so its installed version is read from disk.
const installedClientVersion: string = JSON.parse(
  readFileSync(new URL("../node_modules/dataforseo-client/package.json", import.meta.url), "utf8"),
).version;

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

async function row(measurementId: string) {
  const { rows } = await withSystem("capture.test", (tx) =>
    tx.execute<{
      digest: Buffer | null;
      plan_envelope_sha256: Buffer | null;
      slot_count: number | null;
      frozen_at: Date | null;
    }>(
      sql`select digest, plan_envelope_sha256, slot_count, frozen_at
          from public_panel.measurement_plans where id = ${measurementId}`,
    ),
  );
  return rows[0];
}

async function planEntries(measurementId: string): Promise<number> {
  const { rows } = await withSystem("capture.test", (tx) =>
    tx.execute<{ n: number }>(
      sql`select count(*)::int as n from public_panel.evidence_entries
          where ref = ${measurementId} and kind = 'plan'`,
    ),
  );
  return Number(rows[0]?.n);
}

const newMeasurement = () =>
  createMeasurement({ purpose: "contract-test", refType: "test", refId: randomUUID() });

beforeAll(() => {
  process.env.DB_POOL_MAX = "6";
});
afterAll(() => endPools());

beforeEach(() => {
  for (const [name, value] of Object.entries(previewEnv)) vi.stubEnv(name, value);
  vi.stubEnv("VERCEL_REGION", "iad1");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "fedcba9876543210fedcba9876543210fedcba98");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => fakeR2(new Request(input, init))),
  );
  vi.mocked(loadSigner).mockResolvedValue(signer);
  r2.clear();
  r2Down = false;
  resetPlanCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("createMeasurement", () => {
  test("creates an unfrozen measurement with its purpose and reference", async () => {
    const refId = randomUUID();
    const { measurementId } = await createMeasurement({
      purpose: "free-report",
      refType: "free_report",
      refId,
    });
    expect(measurementId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await row(measurementId)).toMatchObject({
      digest: null,
      slot_count: null,
      frozen_at: null,
    });
  });

  test("an empty reference is invalid input", async () => {
    await expect(
      createMeasurement({ purpose: "free-report", refType: "", refId: "r" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("freezeMeasurementPlan", () => {
  test("freezing seals the plan before any capture and returns stable slot ids", async () => {
    const { measurementId } = await newMeasurement();
    const out = await freezeMeasurementPlan(measurementId, plannedSlots(9));
    expect(out.slotIds).toEqual(range(9).map((i) => `${measurementId}:${i}`));
    const frozen = await row(measurementId);
    expect(frozen).toMatchObject({ slot_count: 9, frozen_at: expect.any(Date) });
    expect(frozen?.digest?.toString("hex")).toBe(out.digest);
    expect(frozen?.plan_envelope_sha256?.toString("hex")).toMatch(/^[0-9a-f]{64}$/);
    expect(await planEntries(measurementId)).toBe(1);
    // The digest names the stored plan artifact, so anyone can fetch and check it.
    const stored = r2.get(`plans/${out.digest}`);
    expect(stored && sha256Hex(stored)).toBe(out.digest);
  });

  test("the sealed plan holds the slots, the engine specs without latency, the client and meta", async () => {
    const { measurementId } = await newMeasurement();
    const slots = plannedSlots(3);
    const meta = { profile: "control-v1" };
    const { digest } = await freezeMeasurementPlan(measurementId, slots, { meta });
    const plan = JSON.parse(new TextDecoder().decode(r2.get(`plans/${digest}`)));
    expect(plan).toMatchObject({ version: 1, measurementId, slots, meta });
    expect(plan.client).toBe(`dataforseo-client@${installedClientVersion}`);
    expect(Object.keys(plan.engines).sort()).toEqual([...ENGINES_CYCLE].sort());
    expect(plan.engines.gemini).not.toHaveProperty("p50LatencyMs");
    expect(plan.engines.gemini).toMatchObject({ provider: "dataforseo", geoSupport: "coordinate" });
    expect(sha256Hex(jcs(plan))).toBe(digest);
  });

  test("freezing again with the same slots is a no-op; with other slots it fails", async () => {
    const { measurementId } = await newMeasurement();
    const first = await freezeMeasurementPlan(measurementId, plannedSlots(4));
    const frozenAt = (await row(measurementId))?.frozen_at;
    await expect(freezeMeasurementPlan(measurementId, plannedSlots(4))).resolves.toEqual(first);
    expect((await row(measurementId))?.frozen_at).toEqual(frozenAt);
    const refreeze = freezeMeasurementPlan(
      measurementId,
      plannedSlots(4, "¿Dónde hay un buen dentista?"),
    );
    await expect(refreeze).rejects.toBeInstanceOf(InvalidInputError);
    await expect(refreeze).rejects.toThrow(/plan already frozen/);
    expect(await planEntries(measurementId)).toBe(1);
  });

  test("concurrent freezes of the same plan seal it once", async () => {
    const { measurementId } = await newMeasurement();
    const results = await Promise.all(
      range(4).map(() => freezeMeasurementPlan(measurementId, plannedSlots(5))),
    );
    expect(new Set(results.map((r) => r.digest)).size).toBe(1);
    expect(await planEntries(measurementId)).toBe(1);
  });

  test("a sealPlan failure leaves the plan unfrozen and a later freeze succeeds", async () => {
    const { measurementId } = await newMeasurement();
    r2Down = true;
    await expect(freezeMeasurementPlan(measurementId, plannedSlots(3))).rejects.toThrow();
    expect(await row(measurementId)).toMatchObject({ digest: null, frozen_at: null });
    expect(await planEntries(measurementId)).toBe(0);
    r2Down = false;
    await expect(freezeMeasurementPlan(measurementId, plannedSlots(3))).resolves.toMatchObject({
      slotIds: range(3).map((i) => `${measurementId}:${i}`),
    });
  });

  test("invalid slots, an empty plan or an unknown measurement are rejected before sealing", async () => {
    const { measurementId } = await newMeasurement();
    const [first] = plannedSlots(1);
    await expect(
      freezeMeasurementPlan(measurementId, [{ ...first, promptText: "" } as PlannedSlot]),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(freezeMeasurementPlan(measurementId, [])).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(freezeMeasurementPlan(randomUUID(), plannedSlots(1))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(r2.size).toBe(0);
  });

  test("a PlannedObservation from the catalog is accepted as a slot", async () => {
    const { measurementId } = await newMeasurement();
    const observations = plannedSlots(2).map((s) =>
      PlannedObservation.parse({
        ...s,
        variantId: `pv_${"a".repeat(16)}`,
        promptSha256: sha256Hex(s.promptText),
        isCanonical: true,
      }),
    );
    const { digest } = await freezeMeasurementPlan(measurementId, observations);
    const plan = JSON.parse(new TextDecoder().decode(r2.get(`plans/${digest}`)));
    expect(plan.slots).toEqual(observations);
  });
});

describe("loadPlan", () => {
  test("returns the frozen slots with their ids and the measurement's reference", async () => {
    const refId = randomUUID();
    const { measurementId } = await createMeasurement({
      purpose: "control-canary",
      refType: "canary",
      refId,
    });
    const slots = plannedSlots(3);
    await freezeMeasurementPlan(measurementId, slots);
    const plan = await loadPlan(measurementId);
    expect(plan).toMatchObject({ purpose: "control-canary", refType: "canary", refId });
    expect(plan.slots).toEqual(
      slots.map((s, slotIndex) => ({
        ...s,
        measurementId,
        slotIndex,
        slotId: `${measurementId}:${slotIndex}`,
      })),
    );
  });

  test("loadPlan verifies the artifact digest", async () => {
    const { measurementId } = await newMeasurement();
    const { digest } = await freezeMeasurementPlan(measurementId, plannedSlots(2));
    r2.set(`plans/${digest}`, new TextEncoder().encode('{"version":1,"slots":[]}'));
    await expect(loadPlan(measurementId)).rejects.toBeInstanceOf(InvalidInputError);
  });

  test("a loaded plan is served from memory afterwards", async () => {
    const { measurementId } = await newMeasurement();
    await freezeMeasurementPlan(measurementId, plannedSlots(2));
    const first = await loadPlan(measurementId);
    const reads = vi.mocked(fetch).mock.calls.length;
    await expect(loadPlan(measurementId)).resolves.toEqual(first);
    expect(vi.mocked(fetch).mock.calls.length).toBe(reads);
  });

  test("an unfrozen or unknown measurement has no plan", async () => {
    const { measurementId } = await newMeasurement();
    await expect(loadPlan(measurementId)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(loadPlan(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });
});
