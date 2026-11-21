import { NotFoundError } from "@reranker/jobs/errors";
import type { BusinessCategory } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import mini from "../../db/test/fixtures/catalog-mini.json" with { type: "json" };
import { readLock } from "../scripts/freeze";
import { templateIntentSet } from "../src/generate/pipeline";
import { getGeo } from "../src/geo/resolve";
import { contentHash, intentSetId, merkleRoot, sha256Hex, variantTemplates } from "../src/hash";
import {
  findIntentIn,
  findVariantIn,
  intentSetBytes,
  openIntentSet,
  sealIntentSet,
  seedIntentSets,
  seedSetFor,
} from "../src/seal";
import { currentSeed, frozenSeed } from "../src/seed/load";
import { buildVariants } from "../src/variants";

const bakery: BusinessCategory = {
  key: "gen:places:bakery",
  source: "places_type",
  label: "Panadería",
  noun: "panadería",
  archetype: "food",
  scope: "local",
  register: "tu",
  placesTypes: ["bakery"],
};
const draft = templateIntentSet(bakery, "local", "co", "es");
const entry = {
  version: "2026.11.0",
  contentHash: "a".repeat(64),
  merkleRoot: "b".repeat(64),
  variantCount: 17,
};
const seed = frozenSeed([entry], () => mini);
const bogota = getGeo("co-c1003659");
const defined = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
};

describe("sealing", () => {
  const set = sealIntentSet(draft);

  test("the id, content hash and root cover the draft", () => {
    expect(set.manifest.contentHash).toBe(contentHash(draft));
    expect(set.manifest.id).toBe(intentSetId(contentHash(draft)));
    expect(set.manifest.merkleRoot).toBe(merkleRoot(variantTemplates(draft)));
    expect(set.intents.every((i) => i.intentSetId === set.manifest.id)).toBe(true);
  });

  test("the stored bytes hash to the content hash and open to the same set", () => {
    const bytes = intentSetBytes(draft);
    expect(sha256Hex(bytes)).toBe(set.manifest.contentHash);
    expect(openIntentSet(bytes)).toEqual(set);
  });

  test("one changed paraphrase changes the id", () => {
    const [first, ...rest] = draft.paraphrases;
    const edited = {
      ...draft,
      paraphrases: [{ ...defined(first), text: `${defined(first).text}?` }, ...rest],
    };
    expect(sealIntentSet(edited).manifest.id).not.toBe(set.manifest.id);
  });

  test("bytes that are not a set are rejected", () =>
    expect(() => openIntentSet(new TextEncoder().encode('{"manifest":{}}'))).toThrow());
});

describe("seed", () => {
  test("no frozen version means no seed", () => expect(frozenSeed([], () => mini)).toBeNull());

  test("the shipped seed is the newest locked version, read once", () => {
    expect(currentSeed()?.version ?? null).toBe(readLock().at(-1)?.version ?? null);
    expect(currentSeed()).toBe(currentSeed());
  });

  test("each key gets its intents under the version's id and hashes", () => {
    const sets = seedIntentSets(defined(seed));
    const dental = seedSetFor(sets, {
      categoryKey: "dental_clinic",
      scope: "local",
      registerProfile: "co",
      language: "es",
    });
    expect(dental?.manifest).toMatchObject({
      id: intentSetId(entry.contentHash),
      kind: "seed",
      version: entry.version,
      contentHash: entry.contentHash,
      merkleRoot: entry.merkleRoot,
      variantCount: 17,
      categoryKey: "dental_clinic",
    });
    expect(dental?.intents.map((i) => i.categoryKey)).not.toContain("online_store");
    expect(dental?.paraphrases.every((p) => p.intentId.startsWith("dental_clinic."))).toBe(true);
    expect(dental?.personas.every((p) => p.categoryKey === "dental_clinic")).toBe(true);
  });

  test("a language the seed was not written in is not served from it", () =>
    expect(
      seedSetFor(seedIntentSets(defined(seed)), {
        categoryKey: "dental_clinic",
        scope: "local",
        registerProfile: "co",
        language: "en",
      }),
    ).toBeNull());
});

describe("lookups", () => {
  const set = sealIntentSet(draft);
  const intent = defined(set.intents[0]);

  test("an intent is found by id and a missing one is not found", () => {
    expect(findIntentIn([set], intent.intentId)).toEqual(intent);
    expect(() => findIntentIn([set], "gen:places:bakery.nothing")).toThrow(NotFoundError);
  });

  test("a variant is rebuilt by id with its prompt filled", () => {
    const variants = buildVariants(set, intent.intentId, bogota, null, "panadería");
    const wanted = defined(variants.at(-1));
    const context = { noun: "panadería", neighborhood: null };
    expect(findVariantIn([set], wanted.variantId, bogota, context)).toEqual(wanted);
    expect(() => findVariantIn([set], "pv_0000000000000000", bogota, context)).toThrow(
      NotFoundError,
    );
  });
});
