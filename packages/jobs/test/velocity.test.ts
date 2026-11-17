import { AppError, cost } from "@reranker/schema";
import { beforeEach, describe, expect, test, vi } from "vitest";

const execute = vi.fn();
const withSystem = vi.fn(async (_reason: string, fn: (tx: unknown) => unknown) => fn({ execute }));
vi.mock("@reranker/db", () => ({ withSystem }));

const { InvalidInputError } = await import("../src/errors");
const { recordVelocity, refreshVelocityBaselines, velocityBaseline } = await import(
  "../src/velocity"
);

const key = "test:velocity:unit";
const sample = { flagged: true, spend: cost(900_000, "USD") };

beforeEach(() => {
  execute.mockReset();
  withSystem.mockClear();
});

describe("recordVelocity", () => {
  test("is one system statement and maps the windows to costs", async () => {
    execute.mockResolvedValue({
      rows: [{ count10m: 12, flagged10m: 1, spend10m: "3600000", spend60m: "4500000" }],
    });
    await expect(recordVelocity(key, sample)).resolves.toEqual({
      count10m: 12,
      flagged10m: 1,
      spend10m: cost(3_600_000, "USD"),
      spend60m: cost(4_500_000, "USD"),
    });
    expect(withSystem).toHaveBeenCalledTimes(1);
    expect(withSystem.mock.calls[0]?.[0]).toBe("jobs.velocity");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("fails loudly when the function returns nothing", async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(recordVelocity(key, sample)).rejects.toThrow("no row");
  });

  test.each(["203.0.113.9", "2001:db8::1", "ana@example.com", ""])(
    "rejects the raw key %j before any statement",
    async (raw) => {
      await expect(recordVelocity(raw, sample)).rejects.toBeInstanceOf(InvalidInputError);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  test.each([
    { amount_micros: -1, currency: "USD" as const },
    { amount_micros: 1.5, currency: "USD" as const },
    cost(1, "COP"),
  ])("rejects spend %j", async (spend) => {
    await expect(recordVelocity(key, { flagged: false, spend })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  test("maps a rejected parameter (22023) to invalid input and lets other failures through", async () => {
    execute.mockRejectedValue(new AppError("internal", { cause: { code: "22023" } }));
    await expect(recordVelocity(key, sample)).rejects.toBeInstanceOf(InvalidInputError);
    const failure = new AppError("service_unavailable", { retryAfterSeconds: 2 });
    execute.mockRejectedValue(failure);
    await expect(recordVelocity(key, sample)).rejects.toBe(failure);
  });
});

describe("velocityBaseline", () => {
  test("maps the row and reads null for a key never seen", async () => {
    execute.mockResolvedValueOnce({ rows: [{ count10m: 10, spend10m: "5", spend60m: "7" }] });
    await expect(velocityBaseline(key)).resolves.toEqual({
      p95Count10m: 10,
      p95Spend10m: cost(5, "USD"),
      p95Spend60m: cost(7, "USD"),
    });
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(velocityBaseline(key)).resolves.toBeNull();
  });

  test("rejects a raw key", async () => {
    await expect(velocityBaseline("203.0.113.9")).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("refreshVelocityBaselines", () => {
  test("returns the number of keys computed", async () => {
    execute.mockResolvedValue({ rows: [{ computed: 4, last: "test:velocity:k4" }] });
    await expect(refreshVelocityBaselines()).resolves.toBe(4);
    execute.mockResolvedValue({ rows: [{ computed: 0, last: null }] });
    await expect(refreshVelocityBaselines()).resolves.toBe(0);
    execute.mockResolvedValue({ rows: [] });
    await expect(refreshVelocityBaselines()).resolves.toBe(0);
  });

  test("walks the keys in batches until one comes back short", async () => {
    execute
      .mockResolvedValueOnce({ rows: [{ computed: 100, last: "test:velocity:k099" }] })
      .mockResolvedValueOnce({ rows: [{ computed: 100, last: "test:velocity:k199" }] })
      .mockResolvedValueOnce({ rows: [{ computed: 37, last: "test:velocity:k236" }] });
    await expect(refreshVelocityBaselines()).resolves.toBe(237);
    expect(withSystem).toHaveBeenCalledTimes(3);
  });
});
