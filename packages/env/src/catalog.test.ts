import { expect, test } from "vitest";
import { auditSecrets, type CatalogEntry, catalog, inCatalog } from "./catalog";

const entry = (over: Partial<CatalogEntry> & { name: string }): CatalogEntry => ({
  kind: "secret",
  vercel: [],
  github: true,
  owner: "test",
  active: true,
  ...over,
});

const entries = [
  entry({ name: "TURBO_REMOTE_CACHE_SIGNATURE_KEY" }),
  entry({ name: "NEON_NONPROD_API_KEY" }),
  entry({ name: "ANTHROPIC_API_KEY_CI", active: false }),
  entry({ name: "DATABASE_URL", github: false }),
];

test("reports a held name the catalog does not allow in GitHub", () => {
  const { unexpected } = auditSecrets(
    ["TURBO_REMOTE_CACHE_SIGNATURE_KEY", "NEON_NONPROD_API_KEY", "OPENAI_API_KEY"],
    entries,
  );
  expect(unexpected).toEqual(["OPENAI_API_KEY"]);
});

test("a name the catalog keeps out of GitHub is unexpected there", () => {
  expect(auditSecrets(["DATABASE_URL"], entries).unexpected).toEqual(["DATABASE_URL"]);
});

test("reports active entries that are absent and ignores the ones not shipped yet", () => {
  const { missing } = auditSecrets(["TURBO_REMOTE_CACHE_SIGNATURE_KEY"], entries);
  expect(missing).toEqual(["NEON_NONPROD_API_KEY"]);
});

test("passes when the repository holds exactly the active entries", () => {
  expect(
    auditSecrets(["TURBO_REMOTE_CACHE_SIGNATURE_KEY", "NEON_NONPROD_API_KEY"], entries),
  ).toEqual({
    unexpected: [],
    missing: [],
  });
});

test("an allowed name that is not active yet is accepted when present", () => {
  expect(auditSecrets(["ANTHROPIC_API_KEY_CI"], entries).unexpected).toEqual([]);
});

test("the shipped catalog accepts what its active GitHub entries describe", () => {
  const names = catalog.filter((e) => e.github && e.active).map((e) => e.name);
  expect(auditSecrets(names, catalog)).toEqual({ unexpected: [], missing: [] });
});

test("catalog names are unique", () => {
  const names = catalog.map((e) => e.name);
  expect(new Set(names).size).toBe(names.length);
});

test("wildcard families cover their members and nothing else", () => {
  expect(inCatalog("SPEND_CAP_DAILY_OPENAI_USD")).toBe(true);
  expect(inCatalog("FREE_REPORT_VELOCITY_WINDOW_MS")).toBe(true);
  expect(inCatalog("EVIDENCE_LOG_KEY_ID")).toBe(true);
  expect(inCatalog("SPEND_CAP_DAILY_USD")).toBe(false);
  expect(inCatalog("UNKNOWN_VARIABLE")).toBe(false);
});
