import { defineEnv, EnvValidationError } from "@reranker/env";
import { describe, expect, test } from "vitest";
import { authEnv } from "./env";

const valid = {
  BETTER_AUTH_SECRET: "s".repeat(32),
  BETTER_AUTH_URL: "https://reranker.co",
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "google-secret",
  RESEND_API_KEY: "re_test",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site-key",
  CAPACITY_HMAC_KEY: "k".repeat(32),
};

const parse = (APP_ENV: string, overrides: Record<string, string | undefined> = {}) =>
  defineEnv([authEnv], { APP_ENV, ...valid, ...overrides });

function message(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
  throw new Error("expected the environment to be rejected");
}

describe("auth environment", () => {
  test("accepts a complete production environment", () => {
    expect(parse("production")).toMatchObject(valid);
  });

  test("names the variable that is missing", () => {
    expect(message(() => parse("production", { GOOGLE_CLIENT_SECRET: undefined }))).toContain(
      "GOOGLE_CLIENT_SECRET (missing)",
    );
  });

  test("the signing secret needs at least 32 characters", () => {
    expect(message(() => parse("production", { BETTER_AUTH_SECRET: "s".repeat(31) }))).toContain(
      "BETTER_AUTH_SECRET (invalid)",
    );
  });

  test("the app URL is https, with http://localhost only in development", () => {
    const local = { BETTER_AUTH_URL: "http://localhost:3000" };
    expect(parse("development", local)).toMatchObject(local);
    for (const APP_ENV of ["preview", "production"]) {
      expect(message(() => parse(APP_ENV, local))).toContain("BETTER_AUTH_URL (invalid)");
    }
    expect(
      message(() => parse("development", { BETTER_AUTH_URL: "http://example.com" })),
    ).toContain("BETTER_AUTH_URL (invalid)");
  });

  test("rotation secrets are optional and must be versioned", () => {
    expect(parse("production").BETTER_AUTH_SECRETS).toBeUndefined();
    expect(parse("production", { BETTER_AUTH_SECRETS: "2:new-secret,1:old-secret" })).toMatchObject(
      {
        BETTER_AUTH_SECRETS: "2:new-secret,1:old-secret",
      },
    );
    expect(message(() => parse("production", { BETTER_AUTH_SECRETS: "new-secret" }))).toContain(
      "BETTER_AUTH_SECRETS (invalid)",
    );
  });
});
