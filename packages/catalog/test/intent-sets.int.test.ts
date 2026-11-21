import { createHash, randomBytes } from "node:crypto";
import { endPools } from "@reranker/db";
import type { BusinessCategory, MeasurementLanguage } from "@reranker/schema/measurement";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import mini from "../../db/test/fixtures/catalog-mini.json" with { type: "json" };
import type { GenerateIntentSetInput } from "../src/generate/pipeline";
import { templateIntentSet } from "../src/generate/pipeline";
import { getGeo } from "../src/geo/resolve";
import { MeasurementLanguageError } from "../src/language";
import { openIntentSet, sealIntentSet } from "../src/seal";
import { type FrozenSeed, frozenSeed } from "../src/seed/load";
import type { IntentSetResolution as Resolution } from "../src/telemetry";

const doubles = vi.hoisted(() => ({
  artifacts: new Map<string, Uint8Array>(),
  configHash: "c".repeat(64),
  outcome: "generated" as "generated" | "template",
  generations: 0,
  transactions: 0,
  reservationFailures: 0,
  seed: null as FrozenSeed | null,
  resolutions: [] as Resolution[],
}));

vi.mock("@reranker/evidence", async () => {
  const { createHash } = await import("node:crypto");
  return {
    putArtifact: async (_kind: string, bytes: Uint8Array) => {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      doubles.artifacts.set(sha256, bytes);
      return { sha256, created: true };
    },
    getArtifact: async (_kind: string, sha256: string) => doubles.artifacts.get(sha256) ?? null,
  };
});
vi.mock("@reranker/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@reranker/db")>();
  return {
    ...original,
    withSystem: ((...args) => {
      doubles.transactions++;
      return original.withSystem(...args);
    }) as typeof original.withSystem,
  };
});
vi.mock("../src/seed/load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/seed/load")>()),
  currentSeed: () => doubles.seed,
}));
vi.mock("../src/generate/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/config")>()),
  languageConfigHash: () => doubles.configHash,
}));
// Stands in for the providers: slow enough for concurrent callers to meet at the claim, and
// taking a system connection mid-call as each spend reservation does.
vi.mock("../src/generate/pipeline", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/generate/pipeline")>();
  const { withSystem } = await import("@reranker/db");
  const { sql } = await import("drizzle-orm");
  return {
    ...original,
    generateIntentSet: async (input: GenerateIntentSetInput) => {
      const n = ++doubles.generations;
      await new Promise((resolve) => setTimeout(resolve, 200));
      await withSystem("jobs.spend", (tx) => tx.execute(sql`select 1`)).catch(() => {
        doubles.reservationFailures++;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const set = original.templateIntentSet(
        input.category,
        input.scope,
        input.registerProfile,
        input.language,
      );
      const report = (fallback: "incomplete" | null) => ({
        candidates: 144,
        guards: {
          placeholder: 2,
          category_noun: 1,
          proper_name: 0,
          qualifier: 0,
          length: 1,
          personal_data: 0,
        },
        dedupe: 3,
        offCentroid: 2,
        judge: 5,
        quota: 0,
        complete: fallback ? 2 : 6,
        fallback,
      });
      if (doubles.outcome === "template") {
        return {
          set,
          report: report("incomplete"),
          outcome: "template",
          generators: 0,
          costMicros: 9000,
        };
      }
      const manifest = {
        ...set.manifest,
        kind: "generated" as const,
        version: `2026-11-20+${n}`,
        generatorConfigHash: doubles.configHash,
        generators: 2 as const,
      };
      return {
        set: { ...set, manifest },
        report: report(null),
        outcome: "generated",
        generators: 2,
        costMicros: 41_000,
      };
    },
  };
});

vi.mock("../src/telemetry", () => ({
  recordIntentSetResolution: (r: Resolution) => doubles.resolutions.push(r),
}));

const { resolveIntentSet, getIntent } = await import("../src/intent-sets");

const outcomes = () => doubles.resolutions.map((r) => [r.outcome, r.fallback]);

const run = randomBytes(4).toString("hex");
const bogota = getGeo("co-c1003659");
const guadalajara = getGeo("mx-c9047210");
const spend = { purpose: "contract-test" as const, refType: "test", refId: run };
const defined = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
};
let owner: pg.Client;

const category = (slug: string): BusinessCategory => ({
  key: `gen:places:${slug}-${run}`,
  source: "places_type",
  label: "Panadería",
  noun: "panadería",
  archetype: "food",
  scope: "local",
  register: "tu",
  placesTypes: ["bakery"],
});

const resolve = (
  slug: string,
  over: { geo?: typeof bogota; language?: MeasurementLanguage; deadlineMs?: number } = {},
) =>
  resolveIntentSet({
    category: category(slug),
    geo: over.geo ?? bogota,
    scope: "local",
    ...(over.language && { language: over.language }),
    deadlineAt: Date.now() + (over.deadlineMs ?? 12_000),
    spend,
  });

async function rows(slug: string) {
  const { rows } = await owner.query<{ set_id: string; content: string; artifact: string }>(
    `select set_id, encode(content_hash, 'hex') as content,
       encode(artifact_sha256, 'hex') as artifact
     from public_panel.intent_sets where category_key = $1 order by created_at`,
    [category(slug).key],
  );
  return rows;
}

beforeAll(async () => {
  owner = new pg.Client({ connectionString: getTestDatabaseUrl("migrations") });
  await owner.connect();
});

beforeEach(() => {
  doubles.generations = 0;
  doubles.transactions = 0;
  doubles.reservationFailures = 0;
  doubles.outcome = "generated";
  doubles.configHash = "c".repeat(64);
  doubles.seed = null;
  doubles.resolutions = [];
});

afterAll(async () => {
  try {
    const pattern = `gen:places:%-${run}%`;
    await owner?.query("delete from public_panel.intent_sets where category_key like $1", [
      pattern,
    ]);
    await owner?.query("delete from public_panel.intent_set_claims where key like $1", [pattern]);
  } finally {
    await Promise.allSettled([owner?.end(), endPools()]);
  }
});

test("seed categories never touch the database", async () => {
  const sha = createHash("sha256").update(run).digest("hex");
  doubles.seed = frozenSeed(
    [{ version: "2026.11.0", contentHash: sha, merkleRoot: sha, variantCount: 17 }],
    () => mini,
  );
  const set = await resolveIntentSet({
    category: { ...category("x"), key: "dental_clinic", source: "seed", archetype: "health" },
    geo: bogota,
    scope: "local",
    deadlineAt: Date.now() + 12_000,
    spend,
  });
  expect(set.manifest).toMatchObject({ kind: "seed", contentHash: sha });
  expect(doubles.transactions).toBe(0);
  expect(doubles.generations).toBe(0);
  expect(outcomes()).toEqual([["seed", null]]);
});

test("a generated set is reused for another business of the same category", async () => {
  const a = await resolve("reuse");
  const b = await resolve("reuse");
  expect(b.manifest.id).toBe(a.manifest.id);
  expect(a.manifest.kind).toBe("generated");
  expect(doubles.generations).toBe(1);
  expect(outcomes()).toEqual([
    ["generated", null],
    ["reused", null],
  ]);
  const [generated, reused] = doubles.resolutions;
  expect(generated).toMatchObject({
    language: "es",
    geoLevel: bogota.level,
    costMicros: 41_000,
    generators: 2,
    guardRejects: 4,
    judgeRejects: 5,
  });
  expect(generated?.generationMs).toBeGreaterThanOrEqual(400);
  expect(reused).toMatchObject({ generationMs: 0, costMicros: 0, generators: 0 });
});

test("another config hash for the language creates a new set and leaves the old one intact", async () => {
  const old = await resolve("config");
  doubles.configHash = "d".repeat(64);
  const next = await resolve("config");
  expect(next.manifest.id).not.toBe(old.manifest.id);
  expect((await rows("config")).map((r) => r.set_id)).toEqual([old.manifest.id, next.manifest.id]);
});

test("after 30 days a new set is generated", async () => {
  const old = await resolve("expiry");
  await owner.query(
    `update public_panel.intent_sets set created_at = now() - interval '31 days'
     where category_key = $1`,
    [category("expiry").key],
  );
  const next = await resolve("expiry");
  expect(next.manifest.id).not.toBe(old.manifest.id);
  expect(doubles.generations).toBe(2);
});

test("ten concurrent requests for a new category generate one set", async () => {
  const sets = await Promise.all(Array.from({ length: 10 }, () => resolve("concurrent")));
  expect(new Set(sets.map((s) => s.manifest.id)).size).toBe(1);
  expect(doubles.generations).toBe(1);
  expect(await rows("concurrent")).toHaveLength(1);
  expect(outcomes().filter(([o]) => o === "generated")).toHaveLength(1);
  expect(outcomes().filter(([o]) => o === "reused")).toHaveLength(9);
});

test("a waiter whose deadline passes before the holder finishes takes the template", async () => {
  const holding = resolve("late");
  const key = `${category("late").key}|local|co|es|${doubles.configHash}`;
  while (
    (await owner.query("select 1 from public_panel.intent_set_claims where key = $1", [key]))
      .rowCount === 0
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const waited = await resolve("late", { deadlineMs: 100 });
  const held = await holding;
  expect(held.manifest.kind).toBe("generated");
  expect(waited.manifest.kind).toBe("template");
  expect(outcomes()).toEqual(
    expect.arrayContaining([
      ["generated", null],
      ["template", "no_time"],
    ]),
  );
});

test("more new categories at once than pool connections: each generates once, no reservation starves", async () => {
  const slugs = Array.from({ length: 8 }, (_, i) => `burst${i}`);
  const sets = await Promise.all(slugs.flatMap((slug) => [resolve(slug), resolve(slug)]));
  expect(doubles.reservationFailures).toBe(0);
  expect(doubles.generations).toBe(slugs.length);
  slugs.forEach((slug, i) => {
    const [a, b] = [sets[2 * i], sets[2 * i + 1]];
    expect(a?.manifest).toMatchObject({ kind: "generated", categoryKey: category(slug).key });
    expect(b?.manifest.id).toBe(a?.manifest.id);
  });
});

test("when the holder falls back, waiters take its template without waiting out the deadline", async () => {
  doubles.outcome = "template";
  const t0 = Date.now();
  const sets = await Promise.all(
    Array.from({ length: 5 }, () => resolve("fallback", { deadlineMs: 10_000 })),
  );
  expect(Date.now() - t0).toBeLessThan(5_000);
  const template = sealIntentSet(templateIntentSet(category("fallback"), "local", "co", "es"));
  expect(new Set(sets.map((s) => s.manifest.id))).toEqual(new Set([template.manifest.id]));
  expect(doubles.generations).toBe(1);
  // Only the holder's fallback is an attempt; the waiters share it.
  expect(outcomes().sort()).toEqual([
    ["template", "incomplete"],
    ...Array.from({ length: 4 }, () => ["template", "shared"]),
  ]);
  expect(doubles.resolutions.find((r) => r.fallback === "incomplete")?.costMicros).toBe(9000);
  // A template is never reused by key: the next request tries to generate again.
  doubles.outcome = "generated";
  expect((await resolve("fallback")).manifest.kind).toBe("generated");
});

test("a claim whose holder died is taken over once it expires", async () => {
  const key = `${category("stale").key}|local|co|es|${doubles.configHash}`;
  await owner.query(
    `insert into public_panel.intent_set_claims (key, expires_at)
     values ($1, now() - interval '1 second')`,
    [key],
  );
  expect((await resolve("stale")).manifest.kind).toBe("generated");
  expect(doubles.generations).toBe(1);
  const { rows: left } = await owner.query(
    "select 1 from public_panel.intent_set_claims where key = $1",
    [key],
  );
  expect(left).toHaveLength(0);
});

test("the stored artifact hashes to its content hash and opens to the same set", async () => {
  const set = await resolve("artifact");
  const [row] = await rows("artifact");
  expect(row).toMatchObject({ set_id: set.manifest.id, content: set.manifest.contentHash });
  expect(row?.artifact).toBe(set.manifest.contentHash);
  expect(openIntentSet(defined(doubles.artifacts.get(set.manifest.contentHash)))).toEqual(set);

  vi.resetModules();
  const fresh = await import("../src/intent-sets");
  const intent = defined(set.intents[0]);
  expect(await fresh.getIntent(set.manifest.id, intent.intentId)).toEqual(intent);
  // The fresh module opened pools of its own.
  await (await import("@reranker/db")).endPools();
  await expect(getIntent("is_0000000000000000", intent.intentId)).rejects.toThrow(/does not exist/);
});

test("co and neutral profiles never share a set", async () => {
  const co = await resolve("profiles");
  const neutral = await resolve("profiles", { geo: guadalajara });
  expect(co.manifest.registerProfile).toBe("co");
  expect(neutral.manifest.registerProfile).toBe("neutral");
  expect(neutral.manifest.id).not.toBe(co.manifest.id);
  expect(doubles.generations).toBe(2);
});

test("each language gets its own set", async () => {
  const es = await resolve("languages");
  const en = await resolve("languages", { language: "en" });
  expect(en.manifest.id).not.toBe(es.manifest.id);
  expect(en.intents.every((i) => i.language === "en")).toBe(true);
  expect((await resolve("languages", { language: "en" })).manifest.id).toBe(en.manifest.id);
  expect(doubles.generations).toBe(2);
});

test("a gendered language without the noun's gender is refused before any lookup", async () => {
  const refused = resolve("gender", { language: "fr" });
  await expect(refused).rejects.toBeInstanceOf(MeasurementLanguageError);
  await expect(refused).rejects.toMatchObject({ gap: "no_noun_gender" });
  expect(doubles.transactions).toBe(0);
});
