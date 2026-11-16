import type { NextConfig } from "next";
import { beforeEach, expect, test, vi } from "vitest";

const nextjsConfig = vi.hoisted(() => ({ withPostHogConfig: vi.fn() }));
vi.mock("@posthog/nextjs-config", () => nextjsConfig);

const { withSourceMaps } = await import("./source-maps");

const config: NextConfig = { devIndicators: false };
const keys = { POSTHOG_API_KEY: "phx_test", POSTHOG_PROJECT_ID: "711803" };

beforeEach(() => {
  nextjsConfig.withPostHogConfig.mockReset().mockReturnValue({ wrapped: true });
});

test("a deployed build with the personal key uploads its source maps for the commit", () => {
  const result = withSourceMaps(config, {
    APP_ENV: "production",
    ...keys,
    VERCEL_GIT_COMMIT_SHA: "abc123",
  });
  expect(result).toEqual({ wrapped: true });
  expect(nextjsConfig.withPostHogConfig).toHaveBeenCalledWith(config, {
    personalApiKey: "phx_test",
    projectId: "711803",
    host: "https://us.posthog.com",
    sourcemaps: { enabled: true, releaseVersion: "abc123", deleteAfterUpload: true },
  });
});

test("an EU project uploads to the EU host", () => {
  withSourceMaps(config, { APP_ENV: "preview", ...keys, NEXT_PUBLIC_POSTHOG_REGION: "eu" });
  expect(nextjsConfig.withPostHogConfig).toHaveBeenCalledWith(
    config,
    expect.objectContaining({ host: "https://eu.posthog.com" }),
  );
});

test("without the key or the project id the build ships unchanged", () => {
  expect(withSourceMaps(config, { APP_ENV: "production" })).toBe(config);
  expect(withSourceMaps(config, { APP_ENV: "production", POSTHOG_API_KEY: "phx_test" })).toBe(
    config,
  );
  expect(withSourceMaps(config, { APP_ENV: "production", ...keys, POSTHOG_API_KEY: "" })).toBe(
    config,
  );
  expect(nextjsConfig.withPostHogConfig).not.toHaveBeenCalled();
});

test("development never uploads", () => {
  expect(withSourceMaps(config, { APP_ENV: "development", ...keys })).toBe(config);
  expect(nextjsConfig.withPostHogConfig).not.toHaveBeenCalled();
});
