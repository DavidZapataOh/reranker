import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { checkLock, freezeVersion, type LockEntry, readLock } from "../scripts/freeze.ts";
import { jcs, merkleRoot, variantTemplates } from "../src/hash";

const FIXTURE = new URL("./fixtures/freeze/", import.meta.url);
const CATALOG = "data/2026.11.0/catalog.json";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyFixtureCatalog(): string {
  const dir = mkdtempSync(join(tmpdir(), "catalog-freeze-"));
  dirs.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function rewrite(dir: string, path: string, edit: (text: string) => string): void {
  const file = join(dir, path);
  writeFileSync(file, edit(readFileSync(file, "utf8")));
}

// RFC 6962 §2.1 written out recursively, on node:crypto, independent of @reranker/verify.
function sha256(...parts: Uint8Array[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}
function referenceRoot(entries: readonly Uint8Array[]): Buffer {
  if (entries.length === 0) return sha256();
  if (entries.length === 1) return sha256(Uint8Array.of(0), entries[0] as Uint8Array);
  let k = 1;
  while (k * 2 < entries.length) k *= 2;
  return sha256(
    Uint8Array.of(1),
    referenceRoot(entries.slice(0, k)),
    referenceRoot(entries.slice(k)),
  );
}
const templates = Array.from({ length: 7 }, (_, i) => ({ intentId: "x.y", paraphraseId: `p${i}` }));
const sortedLeaves = (ts: readonly unknown[]) =>
  ts.map((t) => sha256(jcs(t))).sort((a, b) => a.toString("hex").localeCompare(b.toString("hex")));

test.each([0, 1, 2, 3, 7])("merkle root of %i templates follows RFC 6962", (n) => {
  const slice = templates.slice(0, n);
  expect(merkleRoot(slice)).toBe(referenceRoot(sortedLeaves(slice)).toString("hex"));
});

test("merkle root pins known values and ignores template order", () => {
  expect(merkleRoot([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(merkleRoot([...templates].reverse())).toBe(merkleRoot(templates));
  expect(merkleRoot(templates)).not.toBe(merkleRoot(templates.slice(1)));
});

test("variant templates cover every paraphrase without a persona and with each persona", () => {
  const catalog = JSON.parse(readFileSync(new URL(CATALOG, FIXTURE), "utf8"));
  const ts = variantTemplates(catalog);
  expect(ts).toHaveLength(2 * (1 + 1));
  expect(ts).toContainEqual({
    intentId: "dental_clinic.best_clinic",
    paraphraseId: "dental_clinic.best_clinic.p01",
    format: "keyword",
    text: "clínicas dentales recomendadas en {lugar}",
    personaId: "dental_clinic.parent",
    preamble: "Tengo dos hijos pequeños.",
  });
  expect(ts.filter((t) => t.personaId === null)).toHaveLength(2);
});

test("the registered fixture passes the check", () => {
  expect(() => checkLock(copyFixtureCatalog())).not.toThrow();
});

test("one-character edit in a registered version fails the check", () => {
  const dir = copyFixtureCatalog();
  rewrite(dir, CATALOG, (text) => text.replace("hijos pequeños", "hijas pequeños"));
  expect(() => checkLock(dir)).toThrow(/2026\.11\.0.*content changed/);
});

test("reformatted JSON keeps the same hashes", () => {
  const dir = copyFixtureCatalog();
  rewrite(dir, CATALOG, (text) => JSON.stringify(JSON.parse(text)));
  expect(() => checkLock(dir)).not.toThrow();
});

test("a version in data that is not in the lock fails the check", () => {
  const dir = copyFixtureCatalog();
  cpSync(join(dir, "data/2026.11.0"), join(dir, "data/2026.12.0"), { recursive: true });
  expect(() => checkLock(dir)).toThrow(/2026\.12\.0.*not registered/);
});

test("a registered version missing from data fails the check", () => {
  const dir = copyFixtureCatalog();
  rmSync(join(dir, "data/2026.11.0"), { recursive: true });
  expect(() => checkLock(dir)).toThrow(/2026\.11\.0.*missing/);
});

test("a seed that breaks the schema fails the check", () => {
  const dir = copyFixtureCatalog();
  rewrite(dir, CATALOG, (text) => text.replace('"keyword"', '"riddle"'));
  expect(() => checkLock(dir)).toThrow(/2026\.11\.0/);
});

test("freezing a new version appends it and the check passes", () => {
  const dir = copyFixtureCatalog();
  cpSync(join(dir, "data/2026.11.0"), join(dir, "data/2026.12.0"), { recursive: true });
  rewrite(dir, "data/2026.12.0/catalog.json", (text) => text.replace("p01", "p02"));
  const before = readLock(dir);
  const entry = freezeVersion("2026.12.0", dir);
  expect(readLock(dir)).toEqual([...before, entry]);
  expect(entry).toMatchObject({ version: "2026.12.0", variantCount: 4 });
  expect(entry.contentHash).not.toBe((before[0] as LockEntry).contentHash);
  expect(() => checkLock(dir)).not.toThrow();
});

test("freezing a registered version again is a no-op, and refuses changed content", () => {
  const dir = copyFixtureCatalog();
  const lock = readFileSync(join(dir, "catalog.lock.json"), "utf8");
  expect(freezeVersion("2026.11.0", dir)).toEqual(readLock(dir)[0]);
  expect(readFileSync(join(dir, "catalog.lock.json"), "utf8")).toBe(lock);
  rewrite(dir, CATALOG, (text) => text.replace("p01", "p09"));
  expect(() => freezeVersion("2026.11.0", dir)).toThrow(/2026\.11\.0.*content changed/);
});

test("freezing rejects names that are not seed versions", () => {
  expect(() => freezeVersion("geo", copyFixtureCatalog())).toThrow(/YYYY\.MM\.N/);
});
