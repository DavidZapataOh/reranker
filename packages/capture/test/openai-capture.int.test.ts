import { createHash, randomUUID } from "node:crypto";
import { geoForEngine, getGeo } from "@reranker/catalog";
import { withSystem } from "@reranker/db";
import { InvalidInputError } from "@reranker/jobs/errors";
import type { PlannedSlot } from "@reranker/schema/measurement";
import { sql } from "drizzle-orm";
import { beforeEach, expect, test, vi } from "vitest";
import { captureControl } from "../src/capture";
import { createMeasurement, freezeMeasurementPlan } from "../src/measurement";
import { costFromUsage } from "../src/openai/cost";
import type { SlotId } from "../src/slot";
import {
  fixture,
  INTENT_SET,
  installCaptureHarness,
  ledger,
  openai,
  plannedSlots,
  r2,
  rowsOf,
  statementOf,
} from "./support/capture-harness";

vi.mock("../../evidence/src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));
// Kill switches are PostHog flags; the double reads them from a set of switched-off keys.
const switchedOff = vi.hoisted(() => new Set<string>());
vi.mock("@reranker/flags", async (importOriginal) => {
  const flags = await importOriginal<typeof import("@reranker/flags")>();
  return {
    ...flags,
    assertCaptureAllowed: vi.fn(async (input: Record<string, string>) => {
      const keys = ["channel", "provider", "engine"]
        .map((kind) => `capture-${kind}-${input[kind]}`)
        .filter((key) => switchedOff.has(key));
      if (keys.length > 0) throw new flags.CaptureChannelDisabledError(keys as never);
    }),
  };
});

installCaptureHarness();
beforeEach(() => switchedOff.clear());

const MEDELLIN = "co-c1003654";
const recorded = JSON.parse(
  new TextDecoder().decode(fixture("recorded/openai/control-medellin.json")),
);

function controlSlots(n: number): PlannedSlot[] {
  const geoDeclared = geoForEngine("chatgpt", getGeo(MEDELLIN), "local", { provider: "openai" });
  if (!geoDeclared) throw new Error("ChatGPT is not offered in Colombia");
  return Array.from({ length: n }, (_, runIndex) => ({
    engine: "chatgpt",
    provider: "openai",
    intentSetId: INTENT_SET,
    intentId: "dental_clinic.intent-0" as PlannedSlot["intentId"],
    paraphraseId: "p0",
    geoKey: MEDELLIN,
    geoDeclared,
    runIndex,
    promptText: "¿Qué odontólogo me recomiendas en Medellín?",
  }));
}

async function frozenControl(slots: PlannedSlot[]): Promise<{ m: string; ids: SlotId[] }> {
  const { measurementId } = await createMeasurement({
    purpose: "contract-test",
    refType: "capture-test",
    refId: randomUUID(),
  });
  const { slotIds } = await freezeMeasurementPlan(measurementId, slots);
  return { m: measurementId, ids: slotIds };
}

const opts = (m: string) => ({
  spend: { purpose: "contract-test" as const, refType: "capture-test", refId: m },
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function settledMicros(m: string): Promise<number[]> {
  const { rows } = await withSystem("capture.test", (tx) =>
    tx.execute<{ micros: string }>(
      sql`select actual_amount_micros::text as micros from ops.spend_ledger
          where ref_type = 'capture-test' and ref_id = ${m} and status = 'settled'`,
    ),
  );
  return rows.map((r) => Number(r.micros));
}

test("an API capture is stored with channel api, provider openai and the reported model", async () => {
  const { m, ids } = await frozenControl(controlSlots(1));
  await expect(captureControl(m, ids, opts(m))).resolves.toEqual({ succeeded: ids, failed: [] });
  const [row] = await rowsOf(m);
  expect(row).toMatchObject({
    channel: "api",
    provider: "openai",
    engine: "chatgpt",
    status: "succeeded",
    modelReported: recorded.model,
  });
  expect(statementOf(row?.envelopeSha256 as Buffer).predicate.engine).toMatchObject({
    channel: "api",
    vendor: "openai",
    model_reported: recorded.model,
    tool_version: "web_search_2025_08_26",
    endpoint: "https://api.openai.com/v1/responses",
  });
});

test("the sealed bytes are the wire bytes, and the sealed request declares Medellín and forces search", async () => {
  const { m, ids } = await frozenControl(controlSlots(1));
  await captureControl(m, ids, opts(m));
  const [served] = openai.served;
  const [sent] = openai.requests;
  if (!served || !sent) throw new Error("OpenAI was not called");
  expect(Buffer.from(r2.get(`raw/${sha256(served)}`) ?? []).equals(Buffer.from(served))).toBe(true);
  const sealedRequest = r2.get(`request/${sha256(sent)}`);
  expect(sealedRequest).toBeDefined();
  expect(JSON.parse(new TextDecoder().decode(sealedRequest))).toMatchObject({
    tool_choice: "required",
    tools: [
      {
        type: "web_search_2025_08_26",
        user_location: {
          type: "approximate",
          country: "CO",
          city: "Medellín",
          region: "Antioquia",
        },
      },
    ],
  });
});

test("kill switch capture-channel-api off: zero requests to OpenAI", async () => {
  switchedOff.add("capture-channel-api");
  const { m, ids } = await frozenControl(controlSlots(3));
  const out = await captureControl(m, ids, opts(m));
  expect(out.succeeded).toEqual([]);
  expect(out.failed).toHaveLength(3);
  expect(openai.requests).toHaveLength(0);
  expect(await ledger(m)).toEqual({});
});

test("the reservation settles with the cost from usage", async () => {
  const { m, ids } = await frozenControl(controlSlots(1));
  await captureControl(m, ids, opts(m));
  expect(await settledMicros(m)).toEqual([
    costFromUsage(recorded.usage, 1, recorded.model).amount_micros,
  ]);
});

test("a 400 is stored as provider_error, costs nothing and is not retried", async () => {
  openai.next.push({
    status: 400,
    body: { error: { message: "bad", type: "invalid_request_error", code: "invalid_value" } },
  });
  const { m, ids } = await frozenControl(controlSlots(1));
  const out = await captureControl(m, ids, opts(m));
  expect(out).toEqual({ succeeded: [], failed: [{ slotId: ids[0], code: "ProviderRejected" }] });
  expect(openai.requests).toHaveLength(1);
  expect(await rowsOf(m)).toMatchObject([{ status: "provider_error", httpStatus: 400 }]);
  expect(await ledger(m)).toEqual({ released: 1 });
});

test("a 429 waits as told and the retry stores the answer", async () => {
  openai.next.push({
    status: 429,
    body: { error: { message: "slow down", type: "requests", code: "rate_limit_exceeded" } },
    headers: { "retry-after-ms": "10" },
  });
  const { m, ids } = await frozenControl(controlSlots(1));
  await expect(captureControl(m, ids, opts(m))).resolves.toEqual({ succeeded: ids, failed: [] });
  expect(openai.requests).toHaveLength(2);
});

test("slots routed to another provider are refused before anything is paid", async () => {
  const { m, ids } = await frozenControl(plannedSlots(["gemini"]));
  await expect(captureControl(m, ids, opts(m))).rejects.toThrow(InvalidInputError);
  expect(await ledger(m)).toEqual({});
});
