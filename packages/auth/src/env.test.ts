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
    expect(message(() => parse("production", local))).toContain("BETTER_AUTH_URL (invalid)");
    expect(
      message(() => parse("development", { BETTER_AUTH_URL: "http://example.com" })),
    ).toContain("BETTER_AUTH_URL (invalid)");
  });

  test("development and production pin the app URL; preview derives it from Vercel", () => {
    for (const APP_ENV of ["development", "production"]) {
      expect(message(() => parse(APP_ENV, { BETTER_AUTH_URL: undefined }))).toContain(
        "BETTER_AUTH_URL (missing)",
      );
    }
    const preview = {
      BETTER_AUTH_URL: undefined,
      VERCEL_URL: "reranker-a1b2c3d4e-davidzapataohs-projects.vercel.app",
      VERCEL_BRANCH_URL: "reranker-git-main-davidzapataohs-projects.vercel.app",
    };
    expect(parse("preview", preview)).toMatchObject({
      VERCEL_URL: preview.VERCEL_URL,
      VERCEL_BRANCH_URL: preview.VERCEL_BRANCH_URL,
    });
    expect(parse("preview", { ...preview, VERCEL_BRANCH_URL: undefined }).VERCEL_BRANCH_URL).toBe(
      undefined,
    );
    expect(message(() => parse("preview", { ...preview, VERCEL_URL: undefined }))).toContain(
      "VERCEL_URL (missing)",
    );
    // A fixed URL would serve one preview and break every other.
    expect(
      message(() => parse("preview", { ...preview, BETTER_AUTH_URL: "https://reranker.co" })),
    ).toContain("BETTER_AUTH_URL (forbidden)");
  });

  test("Vercel hosts are bare vercel.app hostnames", () => {
    for (const VERCEL_URL of ["https://x.vercel.app", "reranker.co", "x.vercel.app/path"]) {
      expect(message(() => parse("preview", { BETTER_AUTH_URL: undefined, VERCEL_URL }))).toContain(
        "VERCEL_URL (invalid)",
      );
    }
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
