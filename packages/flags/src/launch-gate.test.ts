import { LAUNCH_CHECK_IDS } from "@reranker/telemetry/launch";
import { describe, expect, test, vi } from "vitest";
import { enabledInProduction, gatedFlagsOn, runEnable } from "./launch-gate";
import type { PostHogApi, RemoteFlag } from "./posthog-api";

type Property = { key: string; type: string; operator: string; value: string[] };
const group = (properties: Property[], rollout = 100) => ({
  properties,
  rollout_percentage: rollout,
});
const env = (operator: string, value: string[]): Property => ({
  key: "env",
  type: "person",
  operator,
  value,
});
const flag = (over: Partial<RemoteFlag> = {}): RemoteFlag => ({
  id: 7,
  key: "free-report-live",
  active: true,
  filters: { groups: [group([])] },
  ...over,
});

describe("enabledInProduction", () => {
  test("an active flag rolled out to everyone is on in production", () => {
    expect(enabledInProduction(flag())).toBe(true);
  });

  test("an inactive flag, a 0% rollout or no condition group is off", () => {
    expect(enabledInProduction(flag({ active: false }))).toBe(false);
    expect(enabledInProduction(flag({ filters: { groups: [group([], 0)] } }))).toBe(false);
    expect(enabledInProduction(flag({ filters: { groups: [] } }))).toBe(false);
  });

  test("an env condition decides whether production matches", () => {
    const only = (operator: string, value: string[]) =>
      enabledInProduction(flag({ filters: { groups: [group([env(operator, value)])] } }));
    expect(only("exact", ["preview"])).toBe(false);
    expect(only("exact", ["preview", "production"])).toBe(true);
    expect(only("is_not", ["production"])).toBe(false);
    expect(only("is_not", ["preview"])).toBe(true);
  });

  test("any other condition may still match someone in production", () => {
    const tenant: Property = {
      key: "tenant_id",
      type: "person",
      operator: "exact",
      value: ["t-1"],
    };
    expect(enabledInProduction(flag({ filters: { groups: [group([tenant], 10)] } }))).toBe(true);
  });
});

function api(flags: RemoteFlag[]): PostHogApi & { setActive: ReturnType<typeof vi.fn> } {
  return {
    listFlags: vi.fn(async () => flags),
    createFlag: vi.fn(),
    setActive: vi.fn(async () => {}),
  };
}

const passing = LAUNCH_CHECK_IDS.map((id) => ({ id, status: "pass" as const, reason: "ok" }));

describe("runEnable", () => {
  test("a gated flag goes on only when every check of its gate passes", async () => {
    const remote = api([flag({ active: false })]);
    const lines: string[] = [];
    await expect(
      runEnable(
        remote,
        "free-report-live",
        async () => passing,
        (l) => lines.push(l),
      ),
    ).resolves.toBe(true);
    expect(remote.setActive).toHaveBeenCalledExactlyOnceWith(7, true);
  });

  test("refuses while a check fails or cannot be verified, naming each one", async () => {
    const remote = api([flag({ key: "accounts", active: false })]);
    const results = passing.map((r) =>
      r.id === "neon-production"
        ? { ...r, status: "fail" as const, reason: "escala a cero encendida" }
        : r.id === "resend-plan"
          ? { ...r, status: "unknown" as const, reason: "falta RESEND_API_KEY" }
          : r,
    );
    const lines: string[] = [];
    await expect(
      runEnable(
        remote,
        "accounts",
        async () => results,
        (l) => lines.push(l),
      ),
    ).resolves.toBe(false);
    expect(remote.setActive).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("neon-production: fail: escala a cero encendida");
    expect(lines.join("\n")).toContain("resend-plan: unknown: falta RESEND_API_KEY");
  });

  test("a flag outside the gate goes on without checks", async () => {
    const remote = api([flag({ id: 9, key: "verify-page", active: false })]);
    const check = vi.fn();
    await expect(runEnable(remote, "verify-page", check, () => {})).resolves.toBe(true);
    expect(check).not.toHaveBeenCalled();
    expect(remote.setActive).toHaveBeenCalledExactlyOnceWith(9, true);
  });

  test("a flag PostHog does not hold cannot be enabled", async () => {
    await expect(
      runEnable(
        api([]),
        "accounts",
        async () => passing,
        () => {},
      ),
    ).resolves.toBe(false);
  });
});

test("gatedFlagsOn reads both gated flags as evaluated for production", async () => {
  const remote = api([
    flag(),
    flag({ id: 8, key: "accounts", filters: { groups: [group([env("exact", ["preview"])])] } }),
  ]);
  await expect(gatedFlagsOn(remote)).resolves.toEqual({
    "free-report-live": true,
    accounts: false,
  });
});

test("every gated flag is a registry flag", async () => {
  const { FLAG_KEYS } = await import("./flag-keys.gen");
  const { LAUNCH_GATES } = await import("@reranker/telemetry/launch");
  for (const key of Object.keys(LAUNCH_GATES)) expect(FLAG_KEYS).toContain(key);
});

test("an env condition with another operator or a single value is read conservatively", () => {
  const single = { key: "env", type: "person", operator: "exact", value: "production" };
  const regex = { key: "env", type: "person", operator: "regex", value: "^prev" };
  expect(
    enabledInProduction(
      flag({ filters: { groups: [{ properties: [single], rollout_percentage: null }] } }),
    ),
  ).toBe(true);
  expect(enabledInProduction(flag({ filters: { groups: [{ properties: [regex] }] } }))).toBe(true);
  expect(enabledInProduction(flag({ filters: null }))).toBe(false);
});
