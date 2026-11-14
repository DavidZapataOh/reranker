import { resetAppEnv } from "@reranker/env";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  captureImmediate: vi.fn(async () => {}),
  captureExceptionImmediate: vi.fn(async () => {}),
  construct: vi.fn(),
}));

vi.mock("posthog-node", () => ({
  PostHog: class {
    captureImmediate = posthog.captureImmediate;
    captureExceptionImmediate = posthog.captureExceptionImmediate;
    constructor(...args: unknown[]) {
      posthog.construct(...args);
    }
  },
}));

// Outside a request `after` throws, so `runAfter` runs the task inline and the tests can await it.
vi.mock("next/server", () => ({
  after: () => {
    throw new Error("outside a request scope");
  },
}));

const { captureServerEvent } = await import("./events");
const { resetPostHogServer } = await import("./posthog-server");

const alert = {
  name: "ops_alert",
  props: { kind: "flags-not-ready", severity: "warning", env: "production" },
} as const;

async function settle() {
  await vi.waitFor(() => expect(posthog.captureImmediate).toHaveBeenCalled());
}

beforeEach(() => {
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test");
  vi.stubEnv("POSTHOG_HOST", "https://us.i.posthog.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  resetAppEnv();
  resetPostHogServer();
});

describe("captureServerEvent", () => {
  test("does nothing outside production", async () => {
    for (const env of ["development", "preview"]) {
      vi.stubEnv("APP_ENV", env);
      resetAppEnv();
      captureServerEvent(alert, { subject: { system: true } });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(posthog.captureImmediate).not.toHaveBeenCalled();
    expect(posthog.construct).not.toHaveBeenCalled();
  });

  test("sends the sanitized, scrubbed event once with the system subject", async () => {
    vi.stubEnv("APP_ENV", "production");
    captureServerEvent(alert, { subject: { system: true } });
    await settle();
    expect(posthog.captureImmediate).toHaveBeenCalledTimes(1);
    expect(posthog.captureImmediate).toHaveBeenCalledWith({
      distinctId: "system",
      event: "ops_alert",
      properties: {
        kind: "flags-not-ready",
        severity: "warning",
        env: "production",
        app_env: "production",
      },
    });
  });

  test.each([
    [{ report: "fr_1" }, "report:fr_1"],
    [{ lead: "ld_1" }, "lead:ld_1"],
    [{ user: "us_1" }, "user:us_1"],
  ])("derives the distinct id from %j", async (subject, distinctId) => {
    vi.stubEnv("APP_ENV", "production");
    captureServerEvent(alert, { subject });
    await settle();
    expect(posthog.captureImmediate).toHaveBeenCalledWith(expect.objectContaining({ distinctId }));
  });

  test("drops properties outside the allow-list and redacts personal data in the rest", async () => {
    vi.stubEnv("APP_ENV", "production");
    captureServerEvent(
      {
        name: "ops_alert",
        props: { kind: "mail ana@x.co", severity: "info", env: "production", email: "a@b.co" },
      } as never,
      { subject: { system: true } },
    );
    await settle();
    const [{ properties }] = posthog.captureImmediate.mock.calls[0] as unknown as [
      { properties: Record<string, unknown> },
    ];
    expect(properties.email).toBeUndefined();
    expect(properties.kind).toBe("mail [redacted]");
  });

  test("creates the client once with the validated environment", async () => {
    vi.stubEnv("APP_ENV", "production");
    captureServerEvent(alert, { subject: { system: true } });
    captureServerEvent(alert, { subject: { system: true } });
    await vi.waitFor(() => expect(posthog.captureImmediate).toHaveBeenCalledTimes(2));
    expect(posthog.construct).toHaveBeenCalledTimes(1);
    expect(posthog.construct).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        host: "https://us.i.posthog.com",
        flushAt: 1,
        flushInterval: 0,
        disableGeoip: true,
        before_send: expect.any(Function),
      }),
    );
  });

  test("swallows a failed delivery and logs it", async () => {
    vi.stubEnv("APP_ENV", "production");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    posthog.captureImmediate.mockRejectedValueOnce(new Error("network down"));
    expect(() => captureServerEvent(alert, { subject: { system: true } })).not.toThrow();
    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
  });

  test("never throws when the environment is unreadable", () => {
    vi.stubEnv("APP_ENV", "");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => captureServerEvent(alert, { subject: { system: true } })).not.toThrow();
    expect(logged).toHaveBeenCalled();
  });

  test("ignores an event the catalog does not know", async () => {
    vi.stubEnv("APP_ENV", "production");
    captureServerEvent({ name: "unknown_event", props: {} } as never, {
      subject: { system: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(posthog.captureImmediate).not.toHaveBeenCalled();
  });
});
