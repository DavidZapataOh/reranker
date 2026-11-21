import { readFileSync } from "node:fs";
import { SeedCatalogFile } from "@reranker/schema/measurement";

export type FrozenSeed = {
  version: string;
  contentHash: string;
  merkleRoot: string;
  variantCount: number;
  catalog: SeedCatalogFile;
};

type LockEntry = Omit<FrozenSeed, "catalog">;

/**
 * The newest version registered in catalog.lock.json, with the hashes `freeze --check` holds to
 * its file in CI; null before any version is frozen.
 */
export function frozenSeed(lock: readonly LockEntry[], read: (version: string) => unknown) {
  const entry = lock.at(-1);
  if (!entry) return null;
  const { version, contentHash, merkleRoot, variantCount } = entry;
  const catalog = SeedCatalogFile.parse(read(version));
  return { version, contentHash, merkleRoot, variantCount, catalog } satisfies FrozenSeed;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));

let current: FrozenSeed | null | undefined;

/** The seed shipped with this build, read once per process. */
export function currentSeed(): FrozenSeed | null {
  if (current === undefined) {
    const lock = readJson(new URL("../../catalog.lock.json", import.meta.url)) as LockEntry[];
    current = frozenSeed(lock, (version) =>
      readJson(new URL(`../../data/${version}/catalog.json`, import.meta.url)),
    );
  }
  return current;
}
