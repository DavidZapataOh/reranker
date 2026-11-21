import { readFileSync } from "node:fs";
import { AppError } from "@reranker/schema";
import { SeedCatalogFile } from "@reranker/schema/measurement";

export type FrozenSeed = {
  version: string;
  contentHash: string;
  merkleRoot: string;
  variantCount: number;
  catalog: SeedCatalogFile;
};

type LockEntry = Omit<FrozenSeed, "catalog">;
type Read = (version: string) => unknown;

function seedAt(entry: LockEntry, read: Read): FrozenSeed {
  const { version, contentHash, merkleRoot, variantCount } = entry;
  const catalog = SeedCatalogFile.parse(read(version));
  return { version, contentHash, merkleRoot, variantCount, catalog };
}

/**
 * The newest version registered in catalog.lock.json, with the hashes `freeze --check` holds to
 * its file in CI; null before any version is frozen.
 */
export function frozenSeed(lock: readonly LockEntry[], read: Read): FrozenSeed | null {
  const entry = lock.at(-1);
  return entry ? seedAt(entry, read) : null;
}

/** One registered version, for series that must keep asking the same questions after newer ones ship. */
export function lockedSeed(lock: readonly LockEntry[], version: string, read: Read): FrozenSeed {
  const entry = lock.find((e) => e.version === version);
  if (!entry) throw new AppError("internal", { detail: `seed ${version} is not frozen` });
  return seedAt(entry, read);
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const readLock = () => readJson(new URL("../../catalog.lock.json", import.meta.url)) as LockEntry[];
const readCatalog = (version: string) =>
  readJson(new URL(`../../data/${version}/catalog.json`, import.meta.url));

let current: FrozenSeed | null | undefined;

/** The seed shipped with this build, read once per process. */
export function currentSeed(): FrozenSeed | null {
  if (current === undefined) current = frozenSeed(readLock(), readCatalog);
  return current;
}

/** A frozen version shipped with this build. */
export function loadSeed(version: string): FrozenSeed {
  return lockedSeed(readLock(), version, readCatalog);
}
