import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const execute = vi.fn();
const withSystem = vi.fn(async (_reason: string, fn: (tx: unknown) => unknown) => fn({ execute }));
vi.mock("@reranker/db", () => ({ withSystem }));
const probeSpendPath = vi.fn();
vi.mock("../src/latency", () => ({ probeSpendPath }));
const tripGuardMode = vi.fn();
const guardModeSince = vi.fn();
vi.mock("../src/guard-mode", () => ({ tripGuardMode, guardModeSince }));
vi.stubEnv("APP_ENV", "development");

const { InvalidInputError } = await import("../src/errors");
const {
  checkPrimitiveLatency,
  checkProviderVolume,
  checkSpendCapPressure,
  primitiveLatency,
  providerVolume,
  spendCapPressure,
} = await import("../src/triggers");

const DAY_MS = 86_400_000;
const stats = (p95: number) => ({ p50: p95 / 2, p95, n: 50 });

beforeEach(() => {
  execute.mockReset();
  probeSpendPath.mockReset();
  tripGuardMode.mockReset();
  guardModeSince.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("spendCapPressure", () => {
  const row = (day: string, used: number, cap = 50_000_000) => ({
    day,
    used_amount_micros: String(used),
    cap_amount_micros: String(cap),
  });

  test("fires when the free report used 70% or more of its cap on each of the last three days", async () => {
    execute.mockResolvedValue({
      rows: [
        row("2026-11-14", 35_000_000),
        row("2026-11-15", 40_000_000),
        row("2026-11-16", 50_000_000),
      ],
    });
    await expect(spendCapPressure("2026-11-16")).resolves.toEqual({
      days: [
        { day: "2026-11-14", ratio: 0.7 },
        { day: "2026-11-15", ratio: 0.8 },
        { day: "2026-11-16", ratio: 1 },
      ],
      fired: true,
    });
  });

  test("a day under 70% or without spend breaks the run", async () => {
    execute.mockResolvedValue({
      rows: [row("2026-11-14", 40_000_000), row("2026-11-16", 40_000_000)],
    });
    const pressure = await spendCapPressure("2026-11-16");
    expect(pressure.fired).toBe(false);
    expect(pressure.days[1]).toEqual({ day: "2026-11-15", ratio: 0 });
    execute.mockResolvedValue({
      rows: [
        row("2026-11-14", 40_000_000),
        row("2026-11-15", 34_999_999),
        row("2026-11-16", 40_000_000),
      ],
    });
    expect((await spendCapPressure("2026-11-16")).fired).toBe(false);
  });

  test("a cap of zero is no pressure", async () => {
    execute.mockResolvedValue({
      rows: ["2026-11-14", "2026-11-15", "2026-11-16"].map((d) => row(d, 0, 0)),
    });
    expect((await spendCapPressure("2026-11-16")).fired).toBe(false);
  });

  test("the check alerts with the three days", async () => {
    execute.mockResolvedValue({
      rows: [
        row("2026-11-14", 35_000_000),
        row("2026-11-15", 40_000_000),
        row("2026-11-16", 45_000_000),
      ],
    });
    const onAlert = vi.fn();
    await checkSpendCapPressure("2026-11-16", { onAlert });
    expect(onAlert).toHaveBeenCalledExactlyOnceWith({
      kind: "spend-cap-pressure",
      payload: {
        scope: "purpose:free-report",
        days: "2026-11-14,2026-11-15,2026-11-16",
        percents: "70,80,90",
      },
    });
  });

  test("needs a calendar day", async () => {
    await expect(spendCapPressure("ayer")).rejects.toBeInstanceOf(InvalidInputError);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("primitive latency", () => {
  test("a reading above 25 ms keeps the trigger mode on for a day and a half", async () => {
    probeSpendPath.mockResolvedValue({ acquireProviderSlot: stats(31.5) });
    guardModeSince.mockResolvedValue(new Date());
    const onAlert = vi.fn();
    await expect(checkPrimitiveLatency({ onAlert })).resolves.toMatchObject({
      p95Ms: 31.5,
      fired: false,
    });
    expect(probeSpendPath).toHaveBeenCalledExactlyOnceWith(50);
    expect(tripGuardMode).toHaveBeenCalledExactlyOnceWith(
      "trigger:primitive-latency",
      "p95 31.5 ms",
      36 * 3_600_000,
    );
    expect(onAlert).not.toHaveBeenCalled();
  });

  test("a reading within budget leaves the mode to lapse", async () => {
    probeSpendPath.mockResolvedValue({ acquireProviderSlot: stats(25) });
    guardModeSince.mockResolvedValue(null);
    await expect(checkPrimitiveLatency()).resolves.toEqual({
      p95Ms: 25,
      since: null,
      fired: false,
    });
    expect(tripGuardMode).not.toHaveBeenCalled();
  });

  test("seven daily readings above budget in a row fire the alert", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-17T10:00:00Z"), toFake: ["Date"] });
    const since = new Date(Date.now() - 6 * DAY_MS);
    probeSpendPath.mockResolvedValue({ acquireProviderSlot: stats(40) });
    guardModeSince.mockResolvedValue(since);
    const onAlert = vi.fn();
    await expect(checkPrimitiveLatency({ onAlert })).resolves.toEqual({
      p95Ms: 40,
      since,
      fired: true,
    });
    expect(onAlert).toHaveBeenCalledExactlyOnceWith({
      kind: "primitive-latency",
      payload: { p95_ms: 40, budget_ms: 25, since: since.toISOString() },
    });
  });

  test("reading the trigger never probes", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-17T10:00:00Z"), toFake: ["Date"] });
    guardModeSince.mockResolvedValue(new Date(Date.now() - 2 * DAY_MS));
    await expect(primitiveLatency()).resolves.toMatchObject({ fired: false });
    expect(probeSpendPath).not.toHaveBeenCalled();
  });
});

describe("provider volume", () => {
  test("counts the month's provider calls in the ledger, without probes or released reservations", async () => {
    execute.mockResolvedValue({ rows: [{ calls: 1_250_000 }] });
    await expect(providerVolume("2026-11")).resolves.toEqual({ calls: 1_250_000, fired: false });
    const query = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(query).toContain("released");
    expect(query).toContain("latency-probe");
  });

  test("more than 2 million calls fire the alert", async () => {
    execute.mockResolvedValue({ rows: [{ calls: 2_000_001 }] });
    const onAlert = vi.fn();
    await checkProviderVolume("2026-11", { onAlert });
    expect(onAlert).toHaveBeenCalledExactlyOnceWith({
      kind: "provider-volume",
      payload: { month: "2026-11", calls: 2_000_001, threshold: 2_000_000 },
    });
    execute.mockResolvedValue({ rows: [{ calls: 2_000_000 }] });
    expect((await providerVolume("2026-11")).fired).toBe(false);
  });

  test("needs a calendar month", async () => {
    await expect(providerVolume("2026-1")).rejects.toBeInstanceOf(InvalidInputError);
  });
});
