import { afterEach, beforeEach, expect, test, vi } from "vitest";

const telemetry = vi.hoisted(() => ({ registerLogger: vi.fn(), getPostHogServer: vi.fn() }));
vi.mock("@reranker/telemetry", () => telemetry);
const posthogNext = vi.hoisted(() => ({
  handler: vi.fn(),
  createOnRequestError: vi.fn(),
}));
vi.mock("@posthog/next", () => posthogNext);
const db = vi.hoisted(() => ({ setDbEventSink: vi.fn() }));
vi.mock("@reranker/db", () => db);
vi.mock("./lib/db-alerts", () => ({ routeDbEvent: "route-db-event" }));
const jobs = vi.hoisted(() => ({ registerJobStarter: vi.fn(), registerJobsTelemetry: vi.fn() }));
vi.mock("@reranker/jobs", () => jobs);
vi.mock("./workflows/jobs/registry", () => ({ startJob: "start-job" }));
vi.mock("./lib/jobs-telemetry", () => ({ jobsTelemetry: "jobs-telemetry" }));

beforeEach(() => {
  vi.resetModules();
  telemetry.registerLogger.mockClear();
  telemetry.getPostHogServer.mockClear();
  db.setDbEventSink.mockClear();
  jobs.registerJobStarter.mockClear();
  jobs.registerJobsTelemetry.mockClear();
  posthogNext.createOnRequestError.mockReset().mockReturnValue(posthogNext.handler);
  globalThis.__envError = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.__envError = undefined;
});

async function register() {
  return (await import("./instrumentation")).register();
}

test("validates on the node runtime and passes with a complete environment", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(32));
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "google-client-id.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "turnstile-secret");
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "turnstile-site");
  vi.stubEnv("CAPACITY_HMAC_KEY", "h".repeat(32));
  await expect(register()).resolves.toBeUndefined();
  expect(globalThis.__envError).toBeUndefined();
  expect(telemetry.registerLogger).toHaveBeenCalledOnce();
  expect(telemetry.getPostHogServer).toHaveBeenCalledOnce();
  expect(db.setDbEventSink).toHaveBeenCalledWith("route-db-event");
  expect(jobs.registerJobStarter).toHaveBeenCalledWith("start-job");
  expect(jobs.registerJobsTelemetry).toHaveBeenCalledWith("jobs-telemetry");
});

test("keeps the error for the health check and rethrows it", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("APP_ENV", "preview");
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
  await expect(register()).rejects.toThrowError(/NEXT_PUBLIC_POSTHOG_KEY \(missing\)/);
  expect(globalThis.__envError?.message).toMatch(/NEXT_PUBLIC_POSTHOG_KEY \(missing\)/);
  expect(telemetry.registerLogger).not.toHaveBeenCalled();
  expect(telemetry.getPostHogServer).not.toHaveBeenCalled();
});

test("does nothing outside the node runtime", async () => {
  vi.stubEnv("NEXT_RUNTIME", "edge");
  vi.stubEnv("APP_ENV", "");
  await expect(register()).resolves.toBeUndefined();
  expect(telemetry.registerLogger).not.toHaveBeenCalled();
  expect(db.setDbEventSink).not.toHaveBeenCalled();
  expect(jobs.registerJobStarter).not.toHaveBeenCalled();
  expect(jobs.registerJobsTelemetry).not.toHaveBeenCalled();
});

test("reports request errors to PostHog with the server token, scrubbed", async () => {
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test");
  vi.stubEnv("POSTHOG_HOST", "https://us.i.posthog.com");
  const { onRequestError } = await import("./instrumentation");
  expect(onRequestError).toBe(posthogNext.handler);
  expect(posthogNext.createOnRequestError).toHaveBeenCalledWith(
    expect.objectContaining({
      apiKey: "phc_test",
      host: "https://us.i.posthog.com",
      disabled: false,
      serverOptions: expect.objectContaining({ disableGeoip: true }),
      beforeCapture: expect.any(Function),
    }),
  );
});
