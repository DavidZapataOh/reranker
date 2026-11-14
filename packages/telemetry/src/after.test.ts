import { resetAppEnv } from "@reranker/env";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  captureExceptionImmediate: vi.fn(async () => {}),
}));
const next = vi.hoisted(() => ({ after: vi.fn() }));

vi.mock("posthog-node", () => ({
  PostHog: class {
    captureExceptionImmediate = posthog.captureExceptionImmediate;
  },
}));
vi.mock("next/server", () => next);

const { runAfter } = await import("./after");
const { resetPostHogServer } = await import("./posthog-server");

beforeEach(() => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test");
  vi.stubEnv("POSTHOG_HOST", "https://us.i.posthog.com");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetAppEnv();
  resetPostHogServer();
});

describe("runAfter", () => {
  test("defers the task to Next after the response", async () => {
    let task: (() => Promise<void>) | undefined;
    next.after.mockImplementation((fn) => {
      task = fn;
    });
    const fn = vi.fn(async () => {});
    runAfter(fn);
    expect(fn).not.toHaveBeenCalled();
    await task?.();
    expect(fn).toHaveBeenCalledOnce();
  });

  test("reports a failing task to PostHog without propagating", async () => {
    let task: (() => Promise<void>) | undefined;
    next.after.mockImplementation((fn) => {
      task = fn;
    });
    const boom = new Error("boom");
    runAfter(async () => {
      throw boom;
    });
    await expect(task?.()).resolves.toBeUndefined();
    expect(posthog.captureExceptionImmediate).toHaveBeenCalledWith(boom);
    expect(console.error).toHaveBeenCalled();
  });

  test("redacts personal data before logging a failure", async () => {
    let task: (() => Promise<void>) | undefined;
    next.after.mockImplementation((fn) => {
      task = fn;
    });
    runAfter(async () => {
      throw new Error("no mail for ana@x.co");
    });
    await task?.();
    const logged = vi.mocked(console.error).mock.calls.flat();
    expect(JSON.stringify(logged.map((e) => (e as Error).message))).not.toMatch(/ana@x\.co/);
  });

  test("still swallows when PostHog itself fails", async () => {
    let task: (() => Promise<void>) | undefined;
    next.after.mockImplementation((fn) => {
      task = fn;
    });
    posthog.captureExceptionImmediate.mockRejectedValueOnce(new Error("posthog down"));
    runAfter(async () => {
      throw new Error("boom");
    });
    await expect(task?.()).resolves.toBeUndefined();
  });

  test("runs inline and swallows errors outside a request", async () => {
    next.after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    const fn = vi.fn(async () => {
      throw new Error("script failure");
    });
    expect(() => runAfter(fn)).not.toThrow();
    expect(fn).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(posthog.captureExceptionImmediate).toHaveBeenCalled());
  });
});
