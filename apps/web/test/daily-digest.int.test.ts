import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { alertDeliveries } from "@reranker/db/schema";
import { resetAppEnv } from "@reranker/env";
import { consumeQuota, reserveSpend, settleSpend } from "@reranker/jobs";
import { cost } from "@reranker/schema";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

// The ops tables are real; the providers, flags and email are doubles, so the test reads back
// exactly what the spend ledger, the Resend quota and the alert deliveries recorded.
const sources = vi.hoisted(() => ({
  dataforseoBalance: vi.fn(async () => ({ balanceUsd: 40 })),
  githubActionsUsage: vi.fn(async () => ({
    minutesUsed: 0,
    includedUsedUsd: 0,
    includedUsd: 12,
    billedUsd: 0,
  })),
  posthogUsage: vi.fn(async () => ({ events: 0, exceptions: 0 })),
  pingHeartbeat: vi.fn(async () => {}),
  sendDailyDigest: vi.fn(async (_date: string, _text: string) => true),
  digestEmailConfigured: vi.fn(() => true),
}));
vi.mock("@reranker/telemetry/digest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/telemetry/digest")>()),
  ...sources,
}));
vi.mock("@reranker/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/telemetry")>()),
  sendOpsAlert: vi.fn(async () => {}),
}));
vi.mock("@reranker/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/flags")>()),
  captureSwitchSnapshot: vi.fn(async () => ({
    switches: {},
    evaluatedAt: new Date().toISOString(),
    definitionsEtag: null,
  })),
}));

// The launch checks call providers; their own tests cover them.
vi.mock("@reranker/telemetry/launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/telemetry/launch")>()),
  runLaunchCheck: vi.fn(async () => []),
}));
vi.mock("../src/lib/launch-state", () => ({
  deploymentInputs: vi.fn(() => ({ crons: [], tracing: false, resendDailyQuota: 100 })),
  readGatedFlags: vi.fn(async () => ({ "free-report-live": false, accounts: false })),
}));

const { runDailyDigest } = await import("../src/workflows/ops/daily-digest");

// A spend day of its own, far from real ones and from the jobs tests' range, so its counters
// start empty on a shared database. Noon in Bogota is 17:00Z.
const year = 9000 + Math.floor(Math.random() * 900);
const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
const day = `${year}-${month}-14`;
const runDate = `${year}-${month}-15`;
const savedAppEnv = process.env.APP_ENV;

beforeAll(() => {
  process.env.APP_ENV = "production";
  resetAppEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterAll(async () => {
  vi.useRealTimers();
  process.env.APP_ENV = savedAppEnv;
  resetAppEnv();
  await endPools();
});

test("reports the closed day's spend per provider and its Resend sends", async () => {
  vi.setSystemTime(new Date(`${day}T17:00:00Z`));
  const reservation = await reserveSpend({
    provider: "dataforseo",
    channel: "api",
    purpose: "benchmark",
    refType: "test",
    refId: randomUUID(),
    estimate: cost(1_000_000, "USD"),
  });
  await settleSpend(reservation, cost(750_000, "USD"));
  await consumeQuota("resend.emails", { priority: "normal", amount: 3 });
  await withSystem("test.digest", (tx) =>
    tx
      .insert(alertDeliveries)
      .values({ kind: "uptime-down", bucketHour: new Date(`${day}T15:00:00Z`) }),
  );

  vi.setSystemTime(new Date(`${runDate}T10:00:00Z`));
  const result = await runDailyDigest(runDate);

  expect(result.sent).toBe(true);
  const text = sources.sendDailyDigest.mock.calls[0]?.[1] ?? "";
  expect(text).toMatch(/- dataforseo: USD\s0,75 de USD\s36,00 · mes: USD\s0,75/);
  expect(text).toMatch(/- Total: USD\s0,75 de USD\s75,00 · mes: USD\s0,75/);
  expect(text).toMatch(/- openai: USD\s0,00 de USD\s14,00/);
  expect(text).toContain(`Topes alcanzados el ${day}: ninguno`);
  expect(text).toContain(`Resend: 4 correos el ${day} de 100`);
  // The volume triggers read the real ops tables: nothing on this far-away day fires them.
  expect(text).toMatch(/Tope del reporte gratis por demanda.*disparador sin cumplir/);
  expect(text).toMatch(/Temporal.*disparador sin cumplir/);
});
