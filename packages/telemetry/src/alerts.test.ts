import { resetAppEnv } from "@reranker/env";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  construct: vi.fn(),
  capture: vi.fn(),
  claim: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  tasks: [] as (() => Promise<void>)[],
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
    constructor(...args: unknown[]) {
      mocks.construct(...args);
    }
  },
}));
vi.mock("./events", () => ({ captureServerEvent: mocks.capture }));
vi.mock("./logger", () => ({ log: { warn: mocks.warn, error: mocks.error } }));
vi.mock("./delivery", () => ({ claimDelivery: mocks.claim }));
vi.mock("./after", () => ({
  runAfter: (fn: () => Promise<void>) => {
    mocks.tasks.push(fn);
  },
}));

const { opsAlerts, sendOpsAlert } = await import("./alerts");

async function flush(): Promise<void> {
  await Promise.all(mocks.tasks.splice(0).map((task) => task()));
}

beforeEach(() => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("OPS_ALERT_EMAIL", "alertas@reranker.co");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  mocks.claim.mockResolvedValue(true);
  mocks.send.mockResolvedValue({ data: { id: "email-1" }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  mocks.tasks.length = 0;
  resetAppEnv();
});

describe("sendOpsAlert", () => {
  test("always logs and emits ops_alert", async () => {
    await sendOpsAlert("free-tier-quota", { source: "neon", pct: 82 });
    expect(mocks.capture).toHaveBeenCalledWith(
      {
        name: "ops_alert",
        props: { kind: "free-tier-quota", severity: "warning", env: "production" },
      },
      { subject: { system: true } },
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      "ops.alert",
      expect.objectContaining({ kind: "free-tier-quota", source: "neon", pct: 82 }),
    );
  });

  test("logs critical alerts as errors", async () => {
    vi.stubEnv("APP_ENV", "development");
    resetAppEnv();
    await sendOpsAlert("uptime-down", {});
    expect(mocks.error).toHaveBeenCalledWith(
      "ops.alert",
      expect.objectContaining({ kind: "uptime-down" }),
    );
  });

  test("emails only critical alerts in production", async () => {
    await sendOpsAlert("free-tier-quota", {});
    await flush();
    expect(mocks.send).not.toHaveBeenCalled();

    vi.stubEnv("APP_ENV", "preview");
    resetAppEnv();
    await sendOpsAlert("uptime-down", {});
    await flush();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  test("emails a critical alert once its delivery is claimed", async () => {
    await sendOpsAlert("uptime-down", { monitor: "landing" });
    await flush();
    expect(mocks.claim).toHaveBeenCalledWith("uptime-down");
    const [payload, options] = mocks.send.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      from: "Reranker alertas <alertas@reranker.co>",
      to: "alertas@reranker.co",
      subject: "[critical] uptime-down",
    });
    expect(payload.text).toContain("monitor: landing");
    expect(payload.html).toBeUndefined();
    expect(options.idempotencyKey).toMatch(/^ops-alert\/uptime-down\//);
  });

  test("10 sends in the same hour deliver one email and ten events", async () => {
    mocks.claim.mockResolvedValueOnce(true).mockResolvedValue(false);
    for (let i = 0; i < 10; i++) await sendOpsAlert("uptime-down", {});
    await flush();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledTimes(10);
  });

  test("skips the email when the delivery was already claimed", async () => {
    mocks.claim.mockResolvedValue(false);
    await sendOpsAlert("uptime-down", {});
    await flush();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  test("email links the runbook", async () => {
    await sendOpsAlert("uptime-down", {});
    await flush();
    expect(mocks.send.mock.calls[0]?.[0].text).toContain(
      `https://github.com/DavidZapataOh/reranker/blob/main/docs/runbooks/${opsAlerts["uptime-down"].runbook}`,
    );
  });

  test("payload severity escalates and never downgrades", async () => {
    await sendOpsAlert("free-tier-quota", { severity: "critical" });
    await flush();
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.capture.mock.calls[0]?.[0].props.severity).toBe("critical");

    mocks.send.mockClear();
    await sendOpsAlert("uptime-down", { severity: "info" });
    await flush();
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  test("without OPS_ALERT_EMAIL it warns once and does not claim", async () => {
    vi.stubEnv("OPS_ALERT_EMAIL", "");
    await sendOpsAlert("uptime-down", {});
    await sendOpsAlert("uptime-down", {});
    await flush();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    const unset = mocks.warn.mock.calls.filter(
      ([message]) => message === "ops.alert.email_unconfigured",
    );
    expect(unset).toHaveLength(1);
  });

  test("a Resend error is swallowed and logged", async () => {
    mocks.send.mockResolvedValue({
      data: null,
      error: { name: "rate_limit_exceeded", message: "slow down" },
    });
    await sendOpsAlert("uptime-down", {});
    await expect(flush()).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalledWith("ops.alert.email_failed", {
      kind: "uptime-down",
      name: "rate_limit_exceeded",
    });
  });

  test("a failing claim never throws", async () => {
    mocks.claim.mockRejectedValue(new Error("connection refused"));
    await sendOpsAlert("uptime-down", {});
    await expect(flush()).resolves.toBeUndefined();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalled();
  });

  test("a failing capture never throws", async () => {
    mocks.capture.mockImplementation(() => {
      throw new Error("posthog down");
    });
    await expect(sendOpsAlert("uptime-down", {})).resolves.toBeUndefined();
  });

  test("redacts personal data from the payload in logs and email", async () => {
    await sendOpsAlert("uptime-down", { note: "contact ana@example.co", email: "ana@example.co" });
    await flush();
    const logged = JSON.stringify(mocks.error.mock.calls);
    const sent = JSON.stringify(mocks.send.mock.calls);
    expect(logged).not.toContain("ana@example.co");
    expect(sent).not.toContain("ana@example.co");
  });
});
