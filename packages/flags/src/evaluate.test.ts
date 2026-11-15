import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { describe, expect, test, vi } from "vitest";
import {
  type Definitions,
  definitions,
  HOST,
  rejectDefinitions,
  serveDefinitions,
  variant,
} from "../test/definitions";
import { setupFlagsTests } from "../test/lifecycle";
import { getFlagsClient } from "./client";
import type { FlagContext } from "./evaluate";

vi.mock("@reranker/telemetry", () => ({ sendOpsAlert: vi.fn(async () => {}) }));

const { getVariant, isEnabled } = await import("./evaluate");

setupFlagsTests();

function onlyWhen(key: string, property: string, value: string): Definitions {
  const base = definitions({ "free-report-live": true });
  const [flag] = base.flags;
  if (!flag) throw new Error("fixture");
  flag.key = key;
  flag.filters.groups = [
    {
      properties: [{ key: property, type: "person", operator: "exact", value: [value] }],
      rollout_percentage: 100,
    },
  ];
  return base;
}

async function loaded(body: Definitions): Promise<void> {
  serveDefinitions(body);
  expect(await getFlagsClient().waitForLocalEvaluationReady(3_000)).toBe(true);
}

describe("isEnabled", () => {
  test("is false while definitions are not loaded, without waiting for them", async () => {
    rejectDefinitions(401);
    const started = performance.now();
    expect(await isEnabled("accounts", { kind: "house" })).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("reads an active flag as on and an inactive one as off", async () => {
    await loaded(definitions({ accounts: true, "verify-page": false }));
    expect(await isEnabled("accounts", { kind: "house" })).toBe(true);
    expect(await isEnabled("verify-page", { kind: "house" })).toBe(false);
  });

  test("an unknown key in PostHog is off and never falls back to a remote request", async () => {
    const remote = vi.fn();
    server.use(
      http.post(`${HOST}/flags/`, () => {
        remote();
        return HttpResponse.json({ flags: {} });
      }),
    );
    await loaded(definitions({ accounts: true }));
    expect(await isEnabled("lead-capture", { kind: "house" })).toBe(false);
    expect(remote).not.toHaveBeenCalled();
  });

  test("tenant context exposes tenant id, plan and country", async () => {
    await loaded(onlyWhen("free-report-live", "plan", "pro"));
    const tenant = { kind: "tenant", tenantId: "8a4c7b9e-5f7d-4c1a-9a3b-2b1d0e6f4a11" } as const;
    expect(await isEnabled("free-report-live", { ...tenant, plan: "pro" })).toBe(true);
    expect(await isEnabled("free-report-live", { ...tenant, plan: "free" })).toBe(false);
    expect(await isEnabled("free-report-live", tenant)).toBe(false);
  });

  test("house context accepts a country", async () => {
    await loaded(onlyWhen("free-report-live", "country", "CO"));
    expect(await isEnabled("free-report-live", { kind: "house", country: "CO" })).toBe(true);
    expect(await isEnabled("free-report-live", { kind: "house", country: "MX" })).toBe(false);
  });

  test("system context targets by engine", async () => {
    await loaded(onlyWhen("free-report-live", "engine", "gemini"));
    expect(await isEnabled("free-report-live", { kind: "system", engine: "gemini" })).toBe(true);
    expect(await isEnabled("free-report-live", { kind: "system", engine: "chatgpt" })).toBe(false);
  });

  test("unset context fields are left out of the properties", async () => {
    await loaded(onlyWhen("free-report-live", "env", "production"));
    const ctx = { kind: "system", engine: undefined } as unknown as FlagContext;
    expect(await isEnabled("free-report-live", ctx)).toBe(true);
  });

  test("targets by environment", async () => {
    await loaded(onlyWhen("free-report-live", "env", "production"));
    expect(await isEnabled("free-report-live", { kind: "system" })).toBe(true);
  });

  test("ui-own reads off even when PostHog has it on", async () => {
    await loaded(definitions({ "capture-channel-ui-own": true }));
    expect(await isEnabled("capture-channel-ui-own", { kind: "system" })).toBe(false);
  });

  test("a remembered result follows new definitions at once", async () => {
    await loaded(definitions({ accounts: true }));
    expect(await isEnabled("accounts", { kind: "house" })).toBe(true);
    serveDefinitions(definitions({ accounts: false }));
    await getFlagsClient().reloadFeatureFlags();
    expect(await isEnabled("accounts", { kind: "house" })).toBe(false);
  });

  test("many distinct subjects evaluate correctly past the remembered limit", async () => {
    await loaded(onlyWhen("free-report-live", "plan", "pro"));
    for (let i = 0; i < 4_200; i++) {
      const plan = i % 2 === 0 ? "pro" : "free";
      const ctx = { kind: "tenant", tenantId: `tenant-${i}`, plan } as const;
      expect(await isEnabled("free-report-live", ctx)).toBe(plan === "pro");
    }
  });

  test("evaluation sends no $feature_flag_called events", async () => {
    const batch = vi.fn();
    server.use(
      http.post(`${HOST}/batch/`, () => {
        batch();
        return HttpResponse.json({});
      }),
    );
    await loaded(definitions({ accounts: true }));
    await isEnabled("accounts", { kind: "house" });
    await getFlagsClient().flush();
    expect(batch).not.toHaveBeenCalled();
  });
});

describe("getVariant", () => {
  test("returns the variant of a multivariate flag", async () => {
    await loaded(variant("control-canary", "canary"));
    expect(await getVariant("control-canary", { kind: "system" })).toBe("canary");
  });

  test("returns undefined for a boolean flag or without definitions", async () => {
    await loaded(definitions({ accounts: true }));
    expect(await getVariant("accounts", { kind: "house" })).toBeUndefined();
    expect(await getVariant("verify-page", { kind: "house" })).toBeUndefined();
  });

  test("returns undefined without definitions", async () => {
    rejectDefinitions(401);
    expect(await getVariant("control-canary", { kind: "system" })).toBeUndefined();
  });
});
