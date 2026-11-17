import { defineEnv } from "@reranker/env";
import { describe, expect, test } from "vitest";
import { fragments } from "./env";

const authVars = {
  BETTER_AUTH_SECRET: "s".repeat(32),
  BETTER_AUTH_URL: "https://reranker.co",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  RESEND_API_KEY: "re_test",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "turnstile-site",
  CAPACITY_HMAC_KEY: "h".repeat(32),
};

const key = {
  ...authVars,
  NEXT_PUBLIC_POSTHOG_KEY: "phc_test",
  POSTHOG_PROJECT_TOKEN: "phc_test",
  POSTHOG_HOST: "https://us.i.posthog.com",
};

describe("web environment", () => {
  test("development needs nothing beyond APP_ENV and the auth variables", () => {
    expect(defineEnv(fragments, { APP_ENV: "development", ...authVars })).toEqual({
      APP_ENV: "development",
      NEXT_PUBLIC_POSTHOG_REGION: "us",
      LOG_LEVEL: "info",
      ...authVars,
    });
  });

  // /api/auth serves every environment, so a deployment without its variables must not start.
  test.each(["development", "preview", "production"])(
    "%s requires the auth variables",
    (APP_ENV) => {
      expect(() => defineEnv(fragments, { APP_ENV })).toThrowError(
        /BETTER_AUTH_SECRET \(missing\).*GOOGLE_CLIENT_ID \(missing\)/,
      );
    },
  );

  test("preview and production require the PostHog key", () => {
    for (const APP_ENV of ["preview", "production"]) {
      expect(() => defineEnv(fragments, { APP_ENV })).toThrowError(
        /NEXT_PUBLIC_POSTHOG_KEY \(missing\)/,
      );
      expect(() => defineEnv(fragments, { APP_ENV, NEXT_PUBLIC_POSTHOG_KEY: "" })).toThrowError(
        /NEXT_PUBLIC_POSTHOG_KEY \(missing\)/,
      );
    }
  });

  test("preview and production require the server PostHog token and host", () => {
    for (const APP_ENV of ["preview", "production"]) {
      expect(() =>
        defineEnv(fragments, { APP_ENV, NEXT_PUBLIC_POSTHOG_KEY: "phc_test" }),
      ).toThrowError(/POSTHOG_PROJECT_TOKEN \(missing\), POSTHOG_HOST \(missing\)/);
    }
  });

  test("the flags key is required in production only and must be a project secret key", () => {
    for (const APP_ENV of ["development", "preview"]) {
      expect(defineEnv(fragments, { APP_ENV, ...key }).POSTHOG_FEATURE_FLAGS_KEY).toBeUndefined();
    }
    expect(() => defineEnv(fragments, { APP_ENV: "production", ...key })).toThrowError(
      /POSTHOG_FEATURE_FLAGS_KEY \(missing\)/,
    );
    expect(() =>
      defineEnv(fragments, { APP_ENV: "production", ...key, POSTHOG_FEATURE_FLAGS_KEY: "phc_1" }),
    ).toThrowError(/POSTHOG_FEATURE_FLAGS_KEY \(invalid\)/);
  });

  test("GA and Clarity ids are accepted only in production", () => {
    const ids = { NEXT_PUBLIC_GA_ID: "G-TEST", NEXT_PUBLIC_CLARITY_ID: "abc123" };
    const flags = {
      POSTHOG_FEATURE_FLAGS_KEY: "phs_test",
      CRON_SECRET: "cron-secret-with-enough-length",
    };
    expect(defineEnv(fragments, { APP_ENV: "production", ...key, ...flags, ...ids })).toMatchObject(
      ids,
    );
    for (const APP_ENV of ["preview", "development"]) {
      expect(() => defineEnv(fragments, { APP_ENV, ...key, ...ids })).toThrowError(
        /NEXT_PUBLIC_GA_ID \(forbidden\), NEXT_PUBLIC_CLARITY_ID \(forbidden\)/,
      );
    }
  });

  test("the cron secret is required in production only and too short a value is rejected", () => {
    expect(defineEnv(fragments, { APP_ENV: "preview", ...key }).CRON_SECRET).toBeUndefined();
    expect(() =>
      defineEnv(fragments, { APP_ENV: "production", ...key, POSTHOG_FEATURE_FLAGS_KEY: "phs_1" }),
    ).toThrowError(/CRON_SECRET \(missing\)/);
    expect(() =>
      defineEnv(fragments, { APP_ENV: "preview", ...key, CRON_SECRET: "short" }),
    ).toThrowError(/CRON_SECRET \(invalid\)/);
  });

  test("the PostHog region defaults to us and rejects unknown values", () => {
    expect(defineEnv(fragments, { APP_ENV: "preview", ...key })).toMatchObject({
      NEXT_PUBLIC_POSTHOG_REGION: "us",
    });
    expect(
      defineEnv(fragments, { APP_ENV: "preview", ...key, NEXT_PUBLIC_POSTHOG_REGION: "eu" }),
    ).toMatchObject({ NEXT_PUBLIC_POSTHOG_REGION: "eu" });
    expect(() =>
      defineEnv(fragments, { APP_ENV: "preview", ...key, NEXT_PUBLIC_POSTHOG_REGION: "asia" }),
    ).toThrowError(/NEXT_PUBLIC_POSTHOG_REGION \(invalid\)/);
  });
});
