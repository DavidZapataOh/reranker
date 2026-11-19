// Seals seed versions: `freeze <version>` registers data/<version>/catalog.json in
// catalog.lock.json, and `freeze --check` fails when a registered version changed or a version
// in data/ was never registered. Usage: pnpm --filter @reranker/catalog freeze --check
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SeedCatalogFile } from "@reranker/schema/measurement";
import { contentHash, merkleRoot, variantTemplates } from "../src/hash.ts";

export type LockEntry = {
  version: string;
  contentHash: string;
  merkleRoot: string;
  variantCount: number;
};

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOCK_FILE = "catalog.lock.json";
const SEED_VERSION = /^\d{4}\.(?:0[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/;

export function readLock(root = PACKAGE_ROOT): LockEntry[] {
  return JSON.parse(readFileSync(join(root, LOCK_FILE), "utf8"));
}

function seedVersions(root: string): string[] {
  return readdirSync(join(root, "data"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SEED_VERSION.test(entry.name))
    .map((entry) => entry.name);
}

function lockEntry(version: string, root: string): LockEntry {
  const file = join(root, "data", version, "catalog.json");
  if (!existsSync(file)) throw new Error(`${version}: registered but missing from data/`);
  // Hashes cover the file as written; the schema only rejects a malformed seed.
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  const parsed = SeedCatalogFile.safeParse(raw);
  if (!parsed.success) throw new Error(`${version}: invalid seed catalog\n${parsed.error.message}`);
  const templates = variantTemplates(parsed.data);
  return {
    version,
    contentHash: contentHash(raw),
    merkleRoot: merkleRoot(templates),
    variantCount: templates.length,
  };
}

function assertUnchanged(registered: LockEntry, root: string): void {
  const current = lockEntry(registered.version, root);
  if (
    current.contentHash !== registered.contentHash ||
    current.merkleRoot !== registered.merkleRoot ||
    current.variantCount !== registered.variantCount
  ) {
    throw new Error(
      `${registered.version}: content changed since it was frozen; publish a new version instead`,
    );
  }
}

export function freezeVersion(version: string, root = PACKAGE_ROOT): LockEntry {
  if (!SEED_VERSION.test(version)) throw new Error(`${version}: seed versions are YYYY.MM.N`);
  const lock = readLock(root);
  const registered = lock.find((entry) => entry.version === version);
  if (registered) {
    assertUnchanged(registered, root);
    return registered;
  }
  const entry = lockEntry(version, root);
  writeFileSync(join(root, LOCK_FILE), `${JSON.stringify([...lock, entry], null, 2)}\n`);
  return entry;
}

export function checkLock(root = PACKAGE_ROOT): void {
  const lock = readLock(root);
  const registered = new Set(lock.map((entry) => entry.version));
  if (registered.size !== lock.length) throw new Error(`${LOCK_FILE} lists a version twice`);
  for (const entry of lock) assertUnchanged(entry, root);
  for (const version of seedVersions(root)) {
    if (!registered.has(version))
      throw new Error(`${version}: not registered; run freeze ${version}`);
  }
}

function main(args: readonly string[]): void {
  const [arg] = args;
  if (args.length !== 1 || arg === undefined) {
    throw new Error("usage: freeze <version> | freeze --check");
  }
  if (arg === "--check") {
    checkLock();
    console.log(`${LOCK_FILE}: ${readLock().length} seed versions unchanged`);
    return;
  }
  const entry = freezeVersion(arg);
  console.log(`${entry.version}: ${entry.variantCount} variants, merkle root ${entry.merkleRoot}`);
}

if (import.meta.main) main(process.argv.slice(2));
