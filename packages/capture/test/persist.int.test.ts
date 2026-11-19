import { jcs } from "@reranker/catalog";
import { readRaw } from "@reranker/evidence";
import { InvalidInputError } from "@reranker/jobs/errors";
import { describe, expect, test, vi } from "vitest";
import { captureLive } from "../src/dataforseo/live";
import { parseAiOverview } from "../src/dataforseo/parse/ai-overview";
import { loadPlan } from "../src/measurement";
import { loadIntentSets, persistCapture } from "../src/persist";
import {
  artifactJson,
  envelopeCount,
  frozen,
  installCaptureHarness,
  MERKLE_ROOT,
  provider,
  rowsOf,
  statementOf,
} from "./support/capture-harness";

vi.mock("../../evidence/src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));

installCaptureHarness();

async function aiOverviewCapture() {
  const { m } = await frozen(["google-ai-overview"]);
  const plan = await loadPlan(m);
  const [slot] = plan.slots;
  if (!slot) throw new Error("the plan has no slot");
  return { m, plan, record: await captureLive({ ...slot }, parseAiOverview) };
}

describe("persistCapture", () => {
  test("seals the fetched bytes and stores the row with their envelope", async () => {
    const { m, plan, record } = await aiOverviewCapture();
    await expect(persistCapture(record, { attempt: 1, late: false })).resolves.toEqual({
      captureId: record.captureId,
      stored: true,
    });
    const [row] = await rowsOf(m);
    if (!row) throw new Error("no capture stored");
    expect(row).toMatchObject({
      id: record.captureId,
      slotIndex: 0,
      attempt: 1,
      engine: "google-ai-overview",
      channel: "ui-vendor",
      status: "succeeded",
      providerStatusCode: 20000,
      parserVersion: 1,
      responseBytes: record.response.length,
      cost_amount_micros: 4000,
      late: false,
      logIndex: null,
    });
    const raw = await readRaw(record.captureId);
    expect(Buffer.from(raw).equals(Buffer.from(provider.served[0] ?? []))).toBe(true);
    expect(artifactJson("normalized", row.normalizedSha256)).toEqual(
      JSON.parse(new TextDecoder().decode(jcs(record.answer))),
    );
    expect(statementOf(row.envelopeSha256).predicate).toMatchObject({
      capture_id: record.captureId,
      plan: { digest: { sha256: plan.planEnvelopeSha256 }, slot: 0, attempt: 1 },
      prompt: {
        set_version: "capture-test@1",
        set_root: MERKLE_ROOT,
        intent_id: "dental_clinic.intent-0",
        paraphrase_id: "p0",
        persona_id: null,
        lang: "es-CO",
        text: "¿Cuál es el mejor odontólogo en Medellín?",
      },
      engine: {
        name: "google-ai-overview",
        surface: "google-search-ai-overview",
        channel: "ui-vendor",
        vendor: "dataforseo",
        vendor_task_id: record.providerTaskId,
        endpoint: "https://sandbox.dataforseo.com/v3/serp/google/organic/live/advanced",
        mode: "live",
        fan_out_queries: null,
      },
      params: { force_web_search: null, temperature: null },
      geo: {
        declared: {
          country: "CO",
          region: "Antioquia",
          city: "Medellín",
          vendor_location_code: 1003654,
        },
      },
      session: { state: "anonymous", fresh: true },
    });
  });

  test("persisting the same capture again stores no second row and signs nothing new", async () => {
    const { m, record } = await aiOverviewCapture();
    await persistCapture(record, { attempt: 1, late: false });
    const envelopes = envelopeCount();
    await expect(persistCapture(record, { attempt: 1, late: false })).resolves.toEqual({
      captureId: record.captureId,
      stored: false,
    });
    expect(envelopeCount()).toBe(envelopes);
    expect(await rowsOf(m)).toHaveLength(1);
  });

  test("a failed seal leaves no row, and persisting again later stores it", async () => {
    const { m, record } = await aiOverviewCapture();
    provider.r2RefusesWrites = true;
    await expect(persistCapture(record, { attempt: 1, late: true })).rejects.toThrow();
    expect(await rowsOf(m)).toHaveLength(0);
    provider.r2RefusesWrites = false;
    await persistCapture(record, { attempt: 1, late: true });
    expect((await rowsOf(m)).map((r) => r.late)).toEqual([true]);
  });

  test("a call without a reported cost keeps the reserved estimate as its cost", async () => {
    const { m, record } = await aiOverviewCapture();
    await persistCapture({ ...record, cost: null, answer: null }, { attempt: 2, late: false });
    expect(await rowsOf(m)).toMatchObject([
      { attempt: 2, cost_amount_micros: 4000, parserVersion: null, normalizedSha256: null },
    ]);
  });

  test("an intent set that is not registered is refused", async () => {
    await expect(loadIntentSets(["is_ffffffffffffffff"])).rejects.toBeInstanceOf(InvalidInputError);
  });
});
