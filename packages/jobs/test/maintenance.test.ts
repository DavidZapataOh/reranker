import { cost } from "@reranker/schema";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const execute = vi.fn();
const withSystem = vi.fn(async (_reason: string, fn: (tx: unknown) => unknown) => fn({ execute }));
vi.mock("@reranker/db", () => ({ withSystem }));
// Reconciliation reads the spend currency from the job config, which needs to know the environment.
vi.stubEnv("APP_ENV", "development");

const { InvalidInputError } = await import("../src/errors");
const { checkWorkflowQuota, cleanupLeases, reconcileSpend, registerSpendSource } = await import(
  "../src/maintenance"
);

const usd = (micros: number) => cost(micros, "USD");

// Sources stay registered for the whole file, so each test sets what they report.
const reported = new Map<string, () => Promise<ReturnType<typeof usd>>>();
registerSpendSource("dataforseo", { usage: () => (reported.get("dataforseo") as () => never)() });
registerSpendSource("brightdata", { usage: () => (reported.get("brightdata") as () => never)() });

beforeEach(() => {
  execute.mockReset();
  withSystem.mockClear();
  reported.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("cleanupLeases", () => {
  test("clears every expired table in one statement and reports what it removed", async () => {
    execute.mockResolvedValue({
      rows: [{ leases: 3, buckets: 2, velocity: 120, breaker_windows: 6 }],
    });
    await expect(cleanupLeases()).resolves.toEqual({
      leases: 3,
      buckets: 2,
      velocity: 120,
      breakerWindows: 6,
    });
    expect(withSystem).toHaveBeenCalledTimes(1);
    expect(withSystem.mock.calls[0]?.[0]).toBe("jobs.maintenance");
  });

  test("fails loudly when the statement returns nothing", async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(cleanupLeases()).rejects.toThrow("no row");
  });
});

describe("registerSpendSource", () => {
  test("a second, different source for the same provider is a bug caught at startup", () => {
    expect(() => registerSpendSource("dataforseo", { usage: async () => usd(0) })).toThrow(
      InvalidInputError,
    );
  });
});

describe("reconcileSpend", () => {
  // The release of stale reservations answers first, then the settled ledger per provider.
  function ledger(released: number, settled: Record<string, number>) {
    execute.mockResolvedValueOnce({ rows: [{ released }] }).mockResolvedValueOnce({
      rows: Object.entries(settled).map(([provider, total]) => ({
        provider,
        total: String(total),
      })),
    });
  }

  test("releases the day's stale reservations and reports only gaps over 5% and US$0.50", async () => {
    ledger(4, { dataforseo: 20_000_000, brightdata: 1_000_000 });
    // 0.9 apart on 20: under 5%. 0.6 apart on 1: over both.
    reported.set("dataforseo", async () => usd(20_900_000));
    reported.set("brightdata", async () => usd(1_600_000));
    await expect(reconcileSpend("2026-11-15")).resolves.toEqual({
      released: 4,
      mismatches: [
        { provider: "brightdata", ledger: usd(1_000_000), provider_reported: usd(1_600_000) },
      ],
    });
  });

  test("a small absolute gap is no mismatch however large in percent", async () => {
    ledger(0, { dataforseo: 100_000 });
    reported.set("dataforseo", async () => usd(500_000));
    reported.set("brightdata", async () => usd(0));
    await expect(reconcileSpend("2026-11-15")).resolves.toEqual({ released: 0, mismatches: [] });
  });

  test("spend the ledger never saw counts against zero", async () => {
    ledger(0, {});
    reported.set("dataforseo", async () => usd(2_000_000));
    reported.set("brightdata", async () => usd(0));
    const { mismatches } = await reconcileSpend("2026-11-15");
    expect(mismatches).toEqual([
      { provider: "dataforseo", ledger: usd(0), provider_reported: usd(2_000_000) },
    ]);
  });

  test("a provider reporting another currency is invalid input, never a silent comparison", async () => {
    ledger(0, { dataforseo: 1_000_000 });
    reported.set("dataforseo", async () => cost(1_000_000, "EUR" as "USD"));
    reported.set("brightdata", async () => usd(0));
    await expect(reconcileSpend("2026-11-15")).rejects.toBeInstanceOf(InvalidInputError);
  });

  test("needs a calendar day", async () => {
    await expect(reconcileSpend("ayer")).rejects.toBeInstanceOf(InvalidInputError);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("checkWorkflowQuota", () => {
  test("estimates the month's events from the runs started, by the event budget of each kind", async () => {
    execute.mockResolvedValue({
      rows: [
        { kind: "daily", runs: 30 },
        { kind: "free-report", runs: 100 },
        { kind: "job", runs: 500 },
      ],
    });
    const onAlert = vi.fn();
    // 30 × 45 + 100 × 85 + 500 × 9 = 14,350 of 50,000.
    await expect(checkWorkflowQuota("2026-11", { onAlert })).resolves.toEqual({
      estimatedEvents: 14_350,
      ratio: 0.287,
    });
    expect(onAlert).not.toHaveBeenCalled();
  });

  test("a kind without its own budget counts as the most expensive one", async () => {
    execute.mockResolvedValue({ rows: [{ kind: "new-workflow", runs: 10 }] });
    await expect(checkWorkflowQuota("2026-11")).resolves.toMatchObject({ estimatedEvents: 850 });
  });

  test("alerts jobs-hobby-quota above 70% of 50,000 events, and not at 70%", async () => {
    const onAlert = vi.fn();
    // 35,000 events is exactly 70%.
    execute.mockResolvedValueOnce({
      rows: [
        { kind: "free-report", runs: 407 },
        { kind: "job", runs: 45 },
      ],
    });
    await checkWorkflowQuota("2026-11", { onAlert });
    expect(onAlert).not.toHaveBeenCalled();
    execute.mockResolvedValueOnce({ rows: [{ kind: "free-report", runs: 412 }] });
    await checkWorkflowQuota("2026-11", { onAlert });
    expect(onAlert).toHaveBeenCalledExactlyOnceWith({
      kind: "jobs-hobby-quota",
      payload: { month: "2026-11", estimated_events: 35_020, limit: 50_000, percent: 70 },
    });
  });

  test("needs a calendar month", async () => {
    for (const month of ["2026-13", "2026-1", "noviembre", "2026-11-01"]) {
      await expect(checkWorkflowQuota(month)).rejects.toBeInstanceOf(InvalidInputError);
    }
    expect(execute).not.toHaveBeenCalled();
  });
});
