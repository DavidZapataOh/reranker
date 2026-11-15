import { resetAppEnv } from "@reranker/env";
import { server } from "@reranker/testing/msw";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { resetFlagsClient } from "../src/client";
import { HOST } from "./definitions";

/** MSW for the definitions endpoint and a fresh flags client per test, as a new instance would start. */
export function setupFlagsTests(): void {
  beforeAll(() => server.listen());
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test");
    vi.stubEnv("POSTHOG_HOST", HOST);
    vi.stubEnv("POSTHOG_FEATURE_FLAGS_KEY", "phs_test");
    resetAppEnv();
  });
  afterEach(async () => {
    await resetFlagsClient();
    server.resetHandlers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetAppEnv();
  });
  afterAll(() => server.close());
}

export function setAppEnv(env: "development" | "preview" | "production"): void {
  vi.stubEnv("APP_ENV", env);
  resetAppEnv();
}
