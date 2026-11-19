import { randomBytes } from "node:crypto";
import { withSystem } from "@reranker/db";
import { captures } from "@reranker/db/schema";
import type { EngineId } from "@reranker/schema";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { type CaptureSlotsOptions, captureSlots } from "../src/capture";
import type { SlotId } from "../src/slot";
import {
  artifactJson,
  fixture,
  frozen,
  INTENT_SET,
  installCaptureHarness,
  ledger,
  provider,
  rowsOf,
  SITE,
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

const CYCLE: EngineId[] = ["gemini", "google-ai-overview", "google-ai-mode"];
const cycle = (n: number) => Array.from({ length: n }, (_, i) => CYCLE[i % 3] as EngineId);

const optsFor = (m: string, extra: Partial<CaptureSlotsOptions> = {}): CaptureSlotsOptions => ({
  mode: "live",
  spend: { purpose: "contract-test", refType: "capture-test", refId: m },
  ...extra,
});

beforeEach(() => switchedOff.clear());

describe("captureSlots", () => {
  test("captures a slot once, settles its cost and attributes Google's redirects to the site", async () => {
    const { m, ids } = await frozen(["google-ai-overview"]);
    await expect(captureSlots(m, ids, optsFor(m))).resolves.toEqual({ succeeded: ids, failed: [] });
    const [row] = await rowsOf(m);
    const sources = artifactJson("normalized", row?.normalizedSha256 ?? null).sources;
    const wrapped = sources.filter((s: { url: string }) => s.url.includes("/goto?"));
    expect(wrapped.length).toBeGreaterThan(0);
    expect(wrapped.every((s: { resolvedUrl?: string }) => s.resolvedUrl === SITE)).toBe(true);
    expect(await ledger(m)).toEqual({ settled: 1 });
  });

  test("a failed seal leaves no row; the next run pays for the slot once more, never a third time", async () => {
    const { m, ids } = await frozen(["gemini"]);
    provider.r2RefusesWrites = true;
    const out = await captureSlots(m, ids, optsFor(m));
    expect(out).toEqual({ succeeded: [], failed: [{ slotId: ids[0], code: expect.any(String) }] });
    expect(await rowsOf(m)).toHaveLength(0);
    provider.r2RefusesWrites = false;
    await expect(captureSlots(m, ids, optsFor(m))).resolves.toMatchObject({ succeeded: ids });
    // A step retried after persisting finds the slot done and settles nothing again.
    await expect(captureSlots(m, ids, optsFor(m))).resolves.toMatchObject({ succeeded: ids });
    expect(provider.calls).toHaveLength(2);
    expect(await ledger(m)).toEqual({ settled: 2 });
  });

  test("retrying a plan with 6 of 9 succeeded slots calls the provider 3 times", async () => {
    const { m, ids } = await frozen(cycle(9));
    await withSystem("capture.test", (tx) =>
      tx.insert(captures).values(
        [0, 1, 2, 3, 4, 5].map((slotIndex) => ({
          id: `cap_${randomBytes(13).toString("hex").toUpperCase()}`,
          measurementId: m,
          slotIndex,
          attempt: 1,
          intentSetId: INTENT_SET,
          intentId: "dental_clinic.intent-0",
          engine: CYCLE[slotIndex % 3] as EngineId,
          channel: "ui-vendor" as const,
          provider: "dataforseo" as const,
          mode: "live" as const,
          status: "succeeded" as const,
          responseBytes: 1,
          latencyMs: 1,
          cost_amount_micros: 4000,
          cost_currency: "USD",
          envelopeSha256: randomBytes(32),
        })),
      ),
    );
    const out = await captureSlots(m, ids, optsFor(m));
    expect(provider.calls).toHaveLength(3);
    expect(out.succeeded.sort()).toEqual([...ids].sort());
  });

  test("kill switch off: zero calls, nothing reserved and CaptureChannelDisabled", async () => {
    const { m, ids } = await frozen(cycle(3));
    switchedOff.add("capture-provider-dataforseo");
    const out = await captureSlots(m, ids, optsFor(m));
    expect(provider.calls).toHaveLength(0);
    expect(out.failed.map((f) => f.code)).toEqual(Array(3).fill("CaptureChannelDisabled"));
    expect(await ledger(m)).toEqual({});
  });

  test("progress is reported once per slot with its outcome", async () => {
    const { m, ids } = await frozen(cycle(3));
    switchedOff.add("capture-engine-gemini");
    const seen: Array<{ slotId: SlotId; ok: boolean }> = [];
    await captureSlots(m, ids, optsFor(m, { onProgress: async (p) => void seen.push(p) }));
    expect(seen.sort((a, b) => a.slotId.localeCompare(b.slotId))).toEqual(
      ids.map((slotId, i) => ({ slotId, ok: i % 3 !== 0 })),
    );
  });

  test("a retryable failure is retried once when time allows, and not when it does not", async () => {
    const { m, ids } = await frozen(["google-ai-mode"]);
    provider.next.push(fixture("errors/50000.bin"));
    await expect(captureSlots(m, ids, optsFor(m))).resolves.toMatchObject({ succeeded: ids });
    expect((await rowsOf(m)).map((r) => [r.attempt, r.status])).toEqual([
      [1, "provider_error"],
      [2, "succeeded"],
    ]);
    // AI Mode's p50 of 6 s after the advertised 5 s wait would end past this cut.
    const tight = await frozen(["google-ai-mode"]);
    provider.next.push(fixture("errors/50000.bin"));
    const deadlineAt = Date.now() + 8_000;
    const out = await captureSlots(tight.m, tight.ids, optsFor(tight.m, { deadlineAt }));
    expect(out.failed).toEqual([{ slotId: tight.ids[0], code: "ProviderUnavailable" }]);
    expect(provider.calls).toHaveLength(3);
  }, 60_000);

  test("calls finishing after deadlineAt are stored as late", async () => {
    const { m, ids } = await frozen(["google-ai-mode"]);
    provider.delayMs = 2500;
    await captureSlots(m, ids, optsFor(m, { deadlineAt: Date.now() + 1500 }));
    expect((await rowsOf(m)).map((r) => [r.status, r.late])).toEqual([["succeeded", true]]);
  });

  test("a slot of another measurement is invalid input", async () => {
    const [{ m }, other] = await Promise.all([frozen(cycle(1)), frozen(cycle(1))]);
    await expect(captureSlots(m, other.ids, optsFor(m))).rejects.toThrow(/not in the plan/);
  });

  test("10× load: three reports of 200 slots at once stay within 28 calls in flight and pay once per call", async () => {
    provider.delayMs = 20;
    const reports = await Promise.all([0, 1, 2].map(() => frozen(cycle(200))));
    const deadlineAt = Date.now() + 85_000;
    const outs = await Promise.all(
      reports.map(({ m, ids }) => captureSlots(m, ids, optsFor(m, { deadlineAt }))),
    );
    expect(provider.maxInFlight).toBeLessThanOrEqual(28);
    expect(outs.flatMap((o) => o.failed)).toEqual([]);
    expect(provider.calls).toHaveLength(600);
    for (const { m } of reports) {
      expect(await ledger(m)).toEqual({ settled: 200 });
      expect(await rowsOf(m)).toHaveLength(200);
    }
  }, 240_000);
});
