import { randomBytes } from "node:crypto";
import { withSystem } from "@reranker/db";
import { captures, evidenceEntries, modelRegimes } from "@reranker/db/schema";
import type { CaptureChannel, CaptureProvider, EngineId } from "@reranker/schema";
import { ModelRegimeStatementV1Schema } from "@reranker/verify/format";
import { and, eq } from "drizzle-orm";
import { beforeEach, expect, test, vi } from "vitest";
import { currentRegime, openRegime, recordModelSeen } from "../src/regimes";
import { frozen, INTENT_SET, installCaptureHarness, statementOf } from "./support/capture-harness";

vi.mock("../../evidence/src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));
const telemetry = vi.hoisted(() => ({
  sendOpsAlert: vi.fn(async (_kind: string, _payload?: Record<string, unknown>) => {}),
  captureServerEvent: vi.fn((_event: { name: string; props: Record<string, unknown> }) => {}),
}));
vi.mock("@reranker/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/telemetry")>()),
  ...telemetry,
}));

installCaptureHarness();

type Key = { engine: EngineId; channel: CaptureChannel; provider: CaptureProvider };
const API: Key = { engine: "chatgpt", channel: "api", provider: "openai" };
const GEMINI: Key = { engine: "gemini", channel: "ui-vendor", provider: "dataforseo" };
const AIO: Key = { engine: "google-ai-overview", channel: "ui-vendor", provider: "dataforseo" };
const T0 = new Date("2026-11-20T10:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

let measurement: { m: string; next: number };

beforeEach(async () => {
  telemetry.sendOpsAlert.mockClear();
  telemetry.captureServerEvent.mockClear();
  // Regimes are kept per engine, channel and provider, so each test starts without them.
  await withSystem("capture.test", async (tx) => {
    for (const key of [API, GEMINI, AIO]) {
      await tx
        .delete(modelRegimes)
        .where(
          and(
            eq(modelRegimes.engine, key.engine),
            eq(modelRegimes.channel, key.channel),
            eq(modelRegimes.provider, key.provider),
          ),
        );
    }
  });
  const { m } = await frozen(["gemini"]);
  measurement = { m, next: 0 };
});

/** A stored capture of `key` reporting `model`, taken at `capturedAt`. */
async function capture(model: string | null, capturedAt: Date, key: Key = API): Promise<string> {
  const id = `cap_${randomBytes(13).toString("hex").toUpperCase()}`;
  await withSystem("capture.test", (tx) =>
    tx.insert(captures).values({
      id,
      capturedAt,
      measurementId: measurement.m,
      slotIndex: 0,
      attempt: ++measurement.next,
      intentSetId: INTENT_SET,
      intentId: "dental_clinic.intent-0",
      ...key,
      mode: "live",
      status: "provider_error",
      modelReported: model,
      responseBytes: 1,
      latencyMs: 1,
      cost_amount_micros: 0,
      cost_currency: "USD",
      envelopeSha256: randomBytes(32),
    }),
  );
  return id;
}

const regimesOf = (key: Key) =>
  withSystem("capture.test", (tx) =>
    tx
      .select()
      .from(modelRegimes)
      .where(
        and(
          eq(modelRegimes.engine, key.engine),
          eq(modelRegimes.channel, key.channel),
          eq(modelRegimes.provider, key.provider),
        ),
      )
      .orderBy(modelRegimes.openedAt),
  );

const modelChangeAlerts = () =>
  telemetry.sendOpsAlert.mock.calls.filter(([kind]) => kind === "model-change");
const regimeEvents = () =>
  telemetry.captureServerEvent.mock.calls.filter(([event]) => event.name === "regime_opened");

test("a second capture with a different model opens a regime, alerts once and emits regime_opened", async () => {
  const first = await recordModelSeen(await capture("gpt-6.1-terra-a", at(0)));
  expect(first.newRegime).toBe(false);
  expect(modelChangeAlerts()).toHaveLength(0);
  const second = await capture("gpt-6.1-terra-b", at(5));
  const r = await recordModelSeen(second);
  expect(r.newRegime).toBe(true);
  expect(modelChangeAlerts()).toEqual([
    [
      "model-change",
      {
        engine: "chatgpt",
        channel: "api",
        provider: "openai",
        from: "gpt-6.1-terra-a",
        to: "gpt-6.1-terra-b",
      },
    ],
  ]);
  expect(regimeEvents()).toEqual([
    [
      {
        name: "regime_opened",
        props: {
          engine: "chatgpt",
          channel: "api",
          from: "gpt-6.1-terra-a",
          to: "gpt-6.1-terra-b",
          first_capture_id: second,
        },
      },
      { subject: { system: true } },
    ],
  ]);
  expect((await regimesOf(API)).map((row) => [row.cause, row.modelReported])).toEqual([
    ["initial", "gpt-6.1-terra-a"],
    ["model", "gpt-6.1-terra-b"],
  ]);
});

test("the same works for DataForSEO UI captures", async () => {
  await recordModelSeen(await capture("gemini-3-flash", at(0), GEMINI));
  expect((await recordModelSeen(await capture("gemini-3-pro", at(1), GEMINI))).newRegime).toBe(
    true,
  );
  expect(modelChangeAlerts()).toHaveLength(1);
});

test("the same model again only counts the capture and widens when it was seen", async () => {
  const { regimeId } = await recordModelSeen(await capture("m", at(10)));
  await recordModelSeen(await capture("m", at(20)));
  await recordModelSeen(await capture("m", at(5)));
  const [row] = await regimesOf(API);
  expect(row).toMatchObject({
    id: regimeId,
    captureCount: 3,
    firstSeenAt: at(5),
    lastSeenAt: at(20),
  });
});

test("two concurrent captures of the new model open one regime", async () => {
  await recordModelSeen(await capture("a", at(0)));
  const ids = await Promise.all([capture("b", at(5)), capture("b", at(6))]);
  const results = await Promise.all(ids.map((id) => recordModelSeen(id)));
  expect(results.filter((r) => r.newRegime)).toHaveLength(1);
  expect(await regimesOf(API)).toHaveLength(2);
  expect(modelChangeAlerts()).toHaveLength(1);
  expect(regimeEvents()).toHaveLength(1);
});

test("a late capture older than the current regime never opens one", async () => {
  await recordModelSeen(await capture("a", at(0)));
  await recordModelSeen(await capture("b", at(40)));
  // Collected from the queue after the 10:40 capture, but taken at 10:05 with the old model.
  const late = await recordModelSeen(await capture("a", at(5)));
  expect(late).toEqual({ newRegime: false, regimeId: null });
  expect(await regimesOf(API)).toHaveLength(2);
  expect((await currentRegime("chatgpt", "api"))?.modelReported).toBe("b");
});

test("captures without a reported model do nothing", async () => {
  expect(await recordModelSeen(await capture(null, at(0), AIO))).toEqual({
    newRegime: false,
    regimeId: null,
  });
  expect(await regimesOf(AIO)).toHaveLength(0);
});

test("a new regime is signed and queued once in the transparency log with kind regime", async () => {
  await recordModelSeen(await capture("a", at(0)));
  const first = await capture("b", at(5));
  const r = await recordModelSeen(first);
  const entries = await withSystem("capture.test", (tx) =>
    tx
      .select({ kind: evidenceEntries.kind, envelope: evidenceEntries.envelopeSha256 })
      .from(evidenceEntries)
      .where(eq(evidenceEntries.ref, r.regimeId as string)),
  );
  expect(entries.map((e) => e.kind)).toEqual(["regime"]);
  const [row] = (await regimesOf(API)).filter((regime) => regime.id === r.regimeId);
  expect(row?.envelopeSha256?.equals(entries[0]?.envelope as Buffer)).toBe(true);
  const statement = statementOf(row?.envelopeSha256 as Buffer);
  expect(ModelRegimeStatementV1Schema.safeParse(statement).success).toBe(true);
  expect(statement.predicate).toMatchObject({
    regime_id: r.regimeId,
    from: "a",
    to: "b",
    first_capture_id: first,
  });
});

test("currentRegime returns the latest regime per engine and channel", async () => {
  expect(await currentRegime("chatgpt", "api")).toBeNull();
  await recordModelSeen(await capture("a", at(0)));
  await recordModelSeen(await capture("b", at(5)));
  expect(await currentRegime("chatgpt", "api", "openai")).toMatchObject({
    modelReported: "b",
    cause: "model",
    since: at(5),
  });
});

test("a drift regime keeps the model in force and opens once", async () => {
  await recordModelSeen(await capture("gemini-3-flash", at(0), GEMINI));
  const input = {
    ...GEMINI,
    cause: "drift" as const,
    openedAt: at(60),
    detail: { alarmed: 18, prompts: 50 },
  };
  const opened = await openRegime(input);
  expect(opened.created).toBe(true);
  expect(await openRegime(input)).toEqual({ regimeId: opened.regimeId, created: false });
  expect(await currentRegime("gemini", "ui-vendor")).toMatchObject({
    regimeId: opened.regimeId,
    cause: "drift",
    modelReported: "gemini-3-flash",
  });
  // The model has not changed, so its next capture counts in the drift regime.
  expect((await recordModelSeen(await capture("gemini-3-flash", at(70), GEMINI))).regimeId).toBe(
    opened.regimeId,
  );
});
