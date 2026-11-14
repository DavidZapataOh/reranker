import { defineEnv } from "@reranker/env";
import { describe, expect, test } from "vitest";
import { fragments } from "./env";

const key = {
  NEXT_PUBLIC_POSTHOG_KEY: "phc_test",
  POSTHOG_PROJECT_TOKEN: "phc_test",
  POSTHOG_HOST: "https://us.i.posthog.com",
};

describe("web environment", () => {
  test("development needs nothing beyond APP_ENV", () => {
    expect(defineEnv(fragments, { APP_ENV: "development" })).toEqual({
      APP_ENV: "development",
      NEXT_PUBLIC_POSTHOG_REGION: "us",
      LOG_LEVEL: "info",
    });
  });

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

  test("GA and Clarity ids are accepted only in production", () => {
    const ids = { NEXT_PUBLIC_GA_ID: "G-TEST", NEXT_PUBLIC_CLARITY_ID: "abc123" };
    expect(defineEnv(fragments, { APP_ENV: "production", ...key, ...ids })).toMatchObject(ids);
    for (const APP_ENV of ["preview", "development"]) {
      expect(() => defineEnv(fragments, { APP_ENV, ...key, ...ids })).toThrowError(
        /NEXT_PUBLIC_GA_ID \(forbidden\), NEXT_PUBLIC_CLARITY_ID \(forbidden\)/,
      );
    }
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
