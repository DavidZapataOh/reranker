import { z } from "@reranker/schema";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  appEnv,
  config,
  defineEnv,
  EnvValidationError,
  forbiddenIn,
  requiredIn,
  resetAppEnv,
  secret,
} from "./index";

const base = { APP_ENV: "production", POSTHOG_FEATURE_FLAGS_KEY: "phs_x" };
const frag = z.object({ POSTHOG_FEATURE_FLAGS_KEY: secret(z.string().startsWith("phs_")) });

function failure(run: () => unknown): EnvValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error("expected defineEnv to throw");
}

describe("defineEnv", () => {
  test("returns the parsed values for a valid source", () => {
    expect(defineEnv([frag], base)).toEqual(base);
  });

  test("names every missing variable", () => {
    expect(() => defineEnv([frag], { APP_ENV: "production" })).toThrowError(
      /POSTHOG_FEATURE_FLAGS_KEY/,
    );
  });

  test("empty string counts as missing", () => {
    const error = failure(() => defineEnv([frag], { ...base, POSTHOG_FEATURE_FLAGS_KEY: "" }));
    expect(error.message).toMatch(/POSTHOG_FEATURE_FLAGS_KEY.*missing/);
    expect(error.issues).toEqual([{ name: "POSTHOG_FEATURE_FLAGS_KEY", problem: "missing" }]);
  });

  test("an empty optional variable is absent, not invalid", () => {
    const f = z.object({ DB_POOL_MAX: config(z.coerce.number().int().positive().optional()) });
    expect(defineEnv([f], { APP_ENV: "preview", DB_POOL_MAX: "" }).DB_POOL_MAX).toBeUndefined();
  });

  test("invalid type is reported as invalid", () => {
    const f = z.object({ DB_POOL_MAX: config(z.coerce.number().int().positive()) });
    expect(() => defineEnv([f], { APP_ENV: "preview", DB_POOL_MAX: "many" })).toThrowError(
      /DB_POOL_MAX.*invalid/,
    );
  });

  test("rejects an unknown APP_ENV", () => {
    expect(() => defineEnv([], { APP_ENV: "staging" })).toThrowError(/APP_ENV/);
  });

  test("rejects a missing APP_ENV", () => {
    expect(failure(() => defineEnv([], {})).issues).toEqual([
      { name: "APP_ENV", problem: "missing" },
    ]);
  });

  test("collects every problem into one error", () => {
    const f = z.object({
      A_KEY: secret(z.string()),
      B_COUNT: config(z.coerce.number()),
      C_FLAG: forbiddenIn(["production"], z.string()),
    });
    const error = failure(() =>
      defineEnv([frag, f], { APP_ENV: "production", B_COUNT: "x", C_FLAG: "on" }),
    );
    expect(error.issues).toEqual(
      expect.arrayContaining([
        { name: "POSTHOG_FEATURE_FLAGS_KEY", problem: "missing" },
        { name: "A_KEY", problem: "missing" },
        { name: "B_COUNT", problem: "invalid" },
        { name: "C_FLAG", problem: "forbidden" },
      ]),
    );
    expect(error.issues).toHaveLength(4);
    expect(error.message).toMatch(/A_KEY \(missing\).*B_COUNT \(invalid\).*C_FLAG \(forbidden\)/);
  });

  test("never echoes values in the message", () => {
    const f = z.object({ TOKEN: secret(z.string().startsWith("tok_")) });
    const error = failure(() => defineEnv([f], { APP_ENV: "preview", TOKEN: "super-secret" }));
    expect(error.message).not.toContain("super-secret");
  });

  test("ignores variables no fragment declares", () => {
    expect(defineEnv([frag], { ...base, UNRELATED: "x" })).not.toHaveProperty("UNRELATED");
  });
});

describe("requiredIn and forbiddenIn", () => {
  test("forbiddenIn fails in the listed env only", () => {
    const f = z.object({
      FREE_REPORT_TEST_DELAY_MS: forbiddenIn(["production"], z.coerce.number().optional()),
    });
    expect(() =>
      defineEnv([f], { APP_ENV: "production", FREE_REPORT_TEST_DELAY_MS: "10" }),
    ).toThrowError(/FREE_REPORT_TEST_DELAY_MS.*forbidden/);
    expect(
      defineEnv([f], { APP_ENV: "preview", FREE_REPORT_TEST_DELAY_MS: "10" })
        .FREE_REPORT_TEST_DELAY_MS,
    ).toBe(10);
  });

  test("forbiddenIn reports forbidden even when the value is also malformed", () => {
    const f = z.object({ DELAY: forbiddenIn(["production"], z.coerce.number().optional()) });
    expect(failure(() => defineEnv([f], { APP_ENV: "production", DELAY: "soon" })).issues).toEqual([
      { name: "DELAY", problem: "forbidden" },
    ]);
  });

  test("forbiddenIn accepts an empty value", () => {
    const f = z.object({ DELAY: forbiddenIn(["production"], z.string().optional()) });
    expect(() => defineEnv([f], { APP_ENV: "production", DELAY: "" })).not.toThrow();
  });

  test("requiredIn production only", () => {
    const f = z.object({ POSTHOG_API_KEY: requiredIn(["production"], z.string()) });
    expect(() => defineEnv([f], { APP_ENV: "production" })).toThrowError(/POSTHOG_API_KEY/);
    expect(() => defineEnv([f], { APP_ENV: "production", POSTHOG_API_KEY: "" })).toThrowError(
      /POSTHOG_API_KEY.*missing/,
    );
    expect(() => defineEnv([f], { APP_ENV: "preview" })).not.toThrow();
  });

  test("requiredIn still validates a value present in another env", () => {
    const f = z.object({
      POSTHOG_API_KEY: requiredIn(["production"], z.string().startsWith("p_")),
    });
    expect(() => defineEnv([f], { APP_ENV: "preview", POSTHOG_API_KEY: "x" })).toThrowError(
      /POSTHOG_API_KEY.*invalid/,
    );
  });

  test("the rules follow the APP_ENV of the source, not process.env", () => {
    vi.stubEnv("APP_ENV", "development");
    const f = z.object({ KEY: requiredIn(["production"], z.string()) });
    expect(() => defineEnv([f], { APP_ENV: "production" })).toThrowError(/KEY/);
    vi.unstubAllEnvs();
  });

  test("keeps the metadata of the wrapped schema", () => {
    const wrapped = requiredIn(["production"], secret(z.string(), "A key"));
    expect(wrapped.meta()).toMatchObject({ kind: "secret", description: "A key" });
    expect(forbiddenIn(["preview"], config(z.string(), "An id")).meta()).toMatchObject({
      kind: "config",
    });
  });
});

describe("appEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetAppEnv();
  });

  test("reads and caches APP_ENV from the process", () => {
    vi.stubEnv("APP_ENV", "preview");
    expect(appEnv()).toBe("preview");
    vi.stubEnv("APP_ENV", "production");
    expect(appEnv()).toBe("preview");
    resetAppEnv();
    expect(appEnv()).toBe("production");
  });

  test("an explicit source bypasses the cache", () => {
    expect(appEnv({ APP_ENV: "development" })).toBe("development");
    expect(appEnv({ APP_ENV: "production" })).toBe("production");
  });

  test("throws naming APP_ENV when invalid or empty", () => {
    expect(() => appEnv({ APP_ENV: "staging" })).toThrowError(/Invalid environment: APP_ENV/);
    expect(() => appEnv({ APP_ENV: "" })).toThrowError(/APP_ENV \(missing\)/);
  });

  test("does not cache a failure", () => {
    vi.stubEnv("APP_ENV", "");
    expect(() => appEnv()).toThrowError(/APP_ENV/);
    vi.stubEnv("APP_ENV", "preview");
    expect(appEnv()).toBe("preview");
  });
});
