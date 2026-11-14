import { afterEach, beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
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
  await expect(register()).resolves.toBeUndefined();
  expect(globalThis.__envError).toBeUndefined();
});

test("keeps the error for the health check and rethrows it", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("APP_ENV", "preview");
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
  await expect(register()).rejects.toThrowError(/NEXT_PUBLIC_POSTHOG_KEY \(missing\)/);
  expect(globalThis.__envError?.message).toMatch(/NEXT_PUBLIC_POSTHOG_KEY \(missing\)/);
});

test("does nothing outside the node runtime", async () => {
  vi.stubEnv("NEXT_RUNTIME", "edge");
  vi.stubEnv("APP_ENV", "");
  await expect(register()).resolves.toBeUndefined();
});
