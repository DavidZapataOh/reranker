import { AppError } from "@reranker/schema";
import { beforeEach, describe, expect, test, vi } from "vitest";

const execute = vi.fn();
const withSystem = vi.fn(async (_reason: string, fn: (tx: unknown) => unknown) => fn({ execute }));
vi.mock("@reranker/db", () => ({ withSystem }));

const { InvalidInputError } = await import("../src/errors");
const { peekTokens, refundTokens, takeTokens } = await import("../src/rate");

const limits = { capacity: 3, refillPerSecond: 0.001 };
const key = "test:rate:unit";

beforeEach(() => {
  execute.mockReset();
  withSystem.mockClear();
});

describe("takeTokens", () => {
  test("is one system statement and maps the row", async () => {
    execute.mockResolvedValue({ rows: [{ ok: false, remaining: [0.5], retry_after_ms: 1234 }] });
    await expect(takeTokens(key, limits, 2)).resolves.toEqual({
      ok: false,
      remaining: 0.5,
      retryAfterMs: 1234,
    });
    expect(withSystem).toHaveBeenCalledTimes(1);
    expect(withSystem.mock.calls[0]?.[0]).toBe("jobs.rate");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("treats an empty balance list as zero", async () => {
    execute.mockResolvedValue({ rows: [{ ok: true, remaining: [], retry_after_ms: 0 }] });
    expect((await takeTokens(key, limits)).remaining).toBe(0);
  });

  test("fails loudly when the function returns nothing", async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(takeTokens(key, limits)).rejects.toThrow("no row");
  });

  test.each([-1, 4, Number.NaN, Number.POSITIVE_INFINITY])("rejects cost %s", async (cost) => {
    await expect(takeTokens(key, limits, cost)).rejects.toBeInstanceOf(InvalidInputError);
    expect(execute).not.toHaveBeenCalled();
  });

  test("maps a rejected parameter (22023) to invalid input", async () => {
    execute.mockRejectedValue(new AppError("internal", { cause: { code: "22023" } }));
    await expect(takeTokens(key, limits)).rejects.toBeInstanceOf(InvalidInputError);
  });

  test("lets other database failures through untouched", async () => {
    const failure = new AppError("service_unavailable", { retryAfterSeconds: 2 });
    execute.mockRejectedValue(failure);
    await expect(takeTokens(key, limits)).rejects.toBe(failure);
    execute.mockRejectedValue(new Error("boom"));
    await expect(takeTokens(key, limits)).rejects.toThrow("boom");
  });
});

describe("peekTokens", () => {
  test("maps the row", async () => {
    execute.mockResolvedValue({ rows: [{ remaining: 2.5, retry_after_ms: 0 }] });
    await expect(peekTokens(key, limits)).resolves.toEqual({ remaining: 2.5, retryAfterMs: 0 });
  });

  test("fails loudly when the function returns nothing", async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(peekTokens(key, limits)).rejects.toThrow("no row");
  });

  test.each([
    { capacity: 0, refillPerSecond: 1 },
    { capacity: 1, refillPerSecond: -1 },
    { capacity: Number.NaN, refillPerSecond: 1 },
    { capacity: 1, refillPerSecond: Number.POSITIVE_INFINITY },
  ])("rejects limits %j", async (bad) => {
    await expect(peekTokens(key, bad)).rejects.toBeInstanceOf(InvalidInputError);
    expect(execute).not.toHaveBeenCalled();
  });

  // The daily cleanup deletes buckets idle for 2 days, which only equals a full bucket when it
  // refills completely within that time.
  test("rejects a bucket that takes longer than 2 days to refill, and takes up to 2 days", async () => {
    const twoDays = 2 * 86_400;
    await expect(
      peekTokens(key, { capacity: 3, refillPerSecond: 3 / (twoDays + 1) }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      takeTokens(key, { capacity: 3, refillPerSecond: 3 / (twoDays + 1) }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(execute).not.toHaveBeenCalled();
    execute.mockResolvedValue({ rows: [{ remaining: 3, retry_after_ms: 0 }] });
    await expect(peekTokens(key, { capacity: 3, refillPerSecond: 3 / twoDays })).resolves.toEqual({
      remaining: 3,
      retryAfterMs: 0,
    });
  });
});

describe("refundTokens", () => {
  test("is one system statement", async () => {
    execute.mockResolvedValue({ rows: [] });
    await refundTokens(key, limits, 2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test.each([-1, Number.NaN])("rejects refund %s", async (cost) => {
    await expect(refundTokens(key, limits, cost)).rejects.toBeInstanceOf(InvalidInputError);
    expect(execute).not.toHaveBeenCalled();
  });

  test("rejects a raw key without a statement", async () => {
    await expect(refundTokens("otp:a@b.co", limits)).rejects.toBeInstanceOf(InvalidInputError);
    expect(withSystem).not.toHaveBeenCalled();
  });
});
