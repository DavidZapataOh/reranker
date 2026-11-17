import { describe, expect, test } from "vitest";
import { predictedWaitMs, providerCapacity } from "../src/capacity";
import { InvalidInputError } from "../src/errors";

describe("predictedWaitMs", () => {
  test("is the demand beyond the limit, in rounds of the median latency", () => {
    expect(
      predictedWaitMs({ queuedSlots: 92, inFlight: 28, limit: 28, p50LatencyMs: 20_000 }),
    ).toBe(65_714);
  });

  test("is zero while demand fits under the limit", () => {
    expect(predictedWaitMs({ queuedSlots: 0, inFlight: 10, limit: 28, p50LatencyMs: 20_000 })).toBe(
      0,
    );
    expect(
      predictedWaitMs({ queuedSlots: 18, inFlight: 10, limit: 28, p50LatencyMs: 20_000 }),
    ).toBe(0);
  });

  test("a limit that is not positive is invalid input, never a division by zero", () => {
    const input = { queuedSlots: 1, inFlight: 1, p50LatencyMs: 1000 };
    expect(() => predictedWaitMs({ ...input, limit: 0 })).toThrow(InvalidInputError);
    expect(() => predictedWaitMs({ ...input, limit: Number.NaN })).toThrow(InvalidInputError);
  });
});

describe("providerCapacity", () => {
  test("a provider without a registered source is an explicit error, never a guessed zero", async () => {
    await expect(providerCapacity("brightdata")).rejects.toBeInstanceOf(InvalidInputError);
  });
});
