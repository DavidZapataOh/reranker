import { afterEach, describe, expect, it, vi } from "vitest";
import { bypassHeaders } from "./playwright.ts";

describe("bypassHeaders", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns {} locally without the secret", () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "");
    expect(bypassHeaders()).toEqual({});
  });

  it("throws in CI without the secret", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "");
    expect(() => bypassHeaders()).toThrow(
      "Missing required environment variable VERCEL_AUTOMATION_BYPASS_SECRET",
    );
  });

  it("sends the bypass and asks Vercel to set the cookie", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "s3cret");
    expect(bypassHeaders()).toEqual({
      "x-vercel-protection-bypass": "s3cret",
      "x-vercel-set-bypass-cookie": "true",
    });
  });
});
