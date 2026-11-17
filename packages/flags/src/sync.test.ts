import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { productionOnly } from "../test/definitions";
import type { PostHogApi, RemoteFlag } from "./posthog-api";
import { type RegistryEntry, registry } from "./registry";
import { checkFlags, expiredReleases, flagPayload, planSync, runCheck, runSync } from "./sync";

const genFile = readFileSync(new URL("./flag-keys.gen.ts", import.meta.url), "utf8");
const remoteAll: RemoteFlag[] = registry.map((r, id) => ({ id, key: r.key, active: false }));
const entry = (key: string) => {
  const found = registry.find((r) => r.key === key);
  if (!found) throw new Error(`no registry entry ${key}`);
  return found;
};

test("creates missing flags disabled", () => {
  const { create } = planSync(registry, []);
  expect(create).toHaveLength(registry.length);
  expect(create.every((f) => f.active === false)).toBe(true);
});

test("never touches existing flags", () => {
  const remote = registry.map((r, id) => ({ id, key: r.key, active: true }));
  expect(planSync(registry, remote).create).toEqual([]);
});

test("creates only what is missing", () => {
  const { create } = planSync(registry, remoteAll.slice(1));
  expect(create.map((f) => f.key)).toEqual([registry[0]?.key]);
});

test("paid providers get the env=production condition", () => {
  expect(flagPayload(entry("capture-provider-openai")).filters.groups[0]?.properties).toEqual([
    { key: "env", type: "person", operator: "exact", value: ["production"] },
  ]);
});

test("the production condition is the one the evaluator tests", () => {
  const expected = productionOnly("capture-provider-openai", false).flags[0]?.filters.groups;
  expect(flagPayload(entry("capture-provider-openai")).filters.groups).toEqual(expected);
});

test("other flags roll out to everyone", () => {
  const payload = flagPayload(entry("accounts"));
  expect(payload.filters.groups).toEqual([{ properties: [], rollout_percentage: 100 }]);
  expect(payload.tags).toEqual([entry("accounts").kind, entry("accounts").owner]);
  expect(payload.name).toBe(entry("accounts").description);
});

test("check passes when PostHog holds every registry key", () => {
  expect(checkFlags(registry, remoteAll, genFile)).toEqual([]);
});

test("check fails when a registry key is missing in PostHog", () => {
  const remote = remoteAll.filter((f) => f.key !== "accounts");
  expect(checkFlags(registry, remote, genFile)).toContain("missing in PostHog: accounts");
});

test("check fails when the generated keys are stale", () => {
  const stale = genFile.replace('  "accounts",\n', "");
  expect(checkFlags(registry, remoteAll, stale)).toEqual([
    "flag-keys.gen.ts is stale: run pnpm --filter @reranker/flags flags:gen",
  ]);
});

const release: RegistryEntry = { ...entry("accounts"), kind: "release", expires: "2027-02-05" };

test("an expired release flag is a warning, a live one is not", () => {
  expect(expiredReleases([release], new Date("2027-02-05T12:00:00Z"))).toEqual([]);
  expect(expiredReleases([release], new Date("2027-02-06T00:00:00Z"))).toEqual([
    "release flag accounts expired on 2027-02-05: remove it",
  ]);
  expect(expiredReleases([entry("capture-channel-api")], new Date("2099-01-01"))).toEqual([]);
});

function fakeApi(remote: RemoteFlag[]): PostHogApi {
  return {
    listFlags: vi.fn(async () => remote),
    createFlag: vi.fn(async () => {}),
    setActive: vi.fn(async () => {}),
  };
}

test("sync creates every missing flag and a second run creates none", async () => {
  const log = vi.fn();
  const api = fakeApi([]);
  expect(await runSync(api, registry, { dryRun: false }, log)).toBe(registry.length);
  expect(api.createFlag).toHaveBeenCalledTimes(registry.length);
  expect(await runSync(fakeApi(remoteAll), registry, { dryRun: false }, log)).toBe(0);
  expect(log).toHaveBeenLastCalledWith("create: 0");
});

test("a dry run lists the flags and creates nothing", async () => {
  const log = vi.fn();
  const api = fakeApi([]);
  await runSync(api, registry, { dryRun: true }, log);
  expect(api.createFlag).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(`would create ${registry[0]?.key}`);
});

test("the check reports problems as errors and expiry as a warning", async () => {
  const log = vi.fn();
  const ok = await runCheck(
    fakeApi(remoteAll.slice(1)),
    [...registry, release],
    genFile,
    new Date("2028-01-01"),
    log,
  );
  expect(ok).toBe(false);
  expect(log).toHaveBeenCalledWith(`::error::missing in PostHog: ${registry[0]?.key}`);
  expect(log).toHaveBeenCalledWith(
    "::warning::release flag accounts expired on 2027-02-05: remove it",
  );
});

test("the check passes with warnings only", async () => {
  const log = vi.fn();
  const ok = await runCheck(fakeApi(remoteAll), registry, genFile, new Date("2099-01-01"), log);
  expect(ok).toBe(true);
});
