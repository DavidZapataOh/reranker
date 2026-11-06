import { afterEach, describe, expect, it, vi } from "vitest";
import { requireEnv } from "./env.ts";

describe("requireEnv", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("returns the value when set", () => {
    vi.stubEnv("SAMPLE_SECRET", "abc");
    expect(requireEnv("SAMPLE_SECRET")).toBe("abc");
  });
  it.each([undefined, "", "   "])("throws naming the variable when value is %j", (v) => {
    vi.stubEnv("SAMPLE_SECRET", v as string);
    expect(() => requireEnv("SAMPLE_SECRET")).toThrow(
      "Missing required environment variable SAMPLE_SECRET",
    );
  });
});
