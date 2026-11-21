import { type SystemTx, withSystem } from "@reranker/db";
import { intentSetClaims, intentSets } from "@reranker/db/schema";
import { getArtifact, putArtifact } from "@reranker/evidence";
import { DEFAULT_COUNTRY_CODE } from "@reranker/i18n/countries";
import type { SpendContext } from "@reranker/jobs";
import { NotFoundError } from "@reranker/jobs/errors";
import { AppError } from "@reranker/schema";
import type {
  BusinessCategory,
  GeoKey,
  GeoTarget,
  Intent,
  IntentId,
  IntentSet,
  IntentSetId,
  IntentSetManifest,
  MeasurementLanguage,
  PromptVariant,
  QuestionScope,
  VariantId,
} from "@reranker/schema/measurement";
import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import { languageConfigHash } from "./generate/config";
import {
  type GenerateIntentSetInput,
  generateIntentSet,
  type IntentSetDraft,
  templateIntentSet,
} from "./generate/pipeline";
import { getGeo } from "./geo/resolve";
import type { Noun } from "./grammar";
import { countryLanguage, requireNounGender } from "./language";
import {
  findIntentIn,
  findVariantIn,
  type IntentSetKey,
  intentSetBytes,
  openIntentSet,
  sealIntentSet,
  seedIntentSets,
  seedSetFor,
} from "./seal";
import { currentSeed } from "./seed/load";
import { setLanguage } from "./variants";

export type ResolveIntentSetInput = {
  category: BusinessCategory;
  geo: GeoTarget;
  scope: QuestionScope;
  deadlineAt: number;
  spend: SpendContext;
  /** Defaults to the main language of the business's country. */
  language?: MeasurementLanguage;
  /** Required with its gender in languages whose templates agree with it; else the category's. */
  noun?: Noun;
  synonyms?: string[];
};

const REASON = "intent-sets";
const REUSE_DAYS = 30;
const POLL_MS = 250;
// A claim outlives its holder's deadline by the time sealing and storing the set can take.
const CLAIM_MARGIN_MS = 10_000;
const CACHE_SIZE = 256;
const CONTENT_TYPE = "application/json";

const cache = new Map<IntentSetId, IntentSet>();
const stored = new Set<IntentSetId>();
let seedSets: ReturnType<typeof seedIntentSets> | null | undefined;

function seed() {
  if (seedSets === undefined) {
    const frozen = currentSeed();
    seedSets = frozen && seedIntentSets(frozen);
  }
  return seedSets;
}

function remember(set: IntentSet): IntentSet {
  cache.delete(set.manifest.id);
  cache.set(set.manifest.id, set);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as IntentSetId);
  return set;
}

async function readStored(setId: string, artifactSha256: Buffer | null): Promise<IntentSet> {
  const hit = cache.get(setId as IntentSetId);
  if (hit) return hit;
  const digest = artifactSha256?.toString("hex");
  const bytes = digest === undefined ? null : await getArtifact("intent-sets", digest);
  if (bytes === null) {
    throw new AppError("internal", { detail: `intent set ${setId} has no readable artifact` });
  }
  const set = openIntentSet(bytes);
  if (set.manifest.id !== setId) {
    throw new AppError("internal", { detail: `artifact of ${setId} seals as ${set.manifest.id}` });
  }
  return remember(set);
}

// Templates are never reused by key, or one provider outage would pin a category to them for a
// month; they are stored so their id resolves like any other set.
function reusable(tx: SystemTx, key: IntentSetKey) {
  return tx
    .select({ setId: intentSets.setId, artifactSha256: intentSets.artifactSha256 })
    .from(intentSets)
    .where(
      and(
        eq(intentSets.categoryKey, key.categoryKey),
        eq(intentSets.scope, key.scope),
        eq(intentSets.registerProfile, key.registerProfile),
        eq(intentSets.generatorConfigHash, Buffer.from(languageConfigHash(key.language), "hex")),
        eq(intentSets.language, key.language),
        eq(intentSets.kind, "generated"),
        gt(intentSets.createdAt, sql`now() - make_interval(days => ${REUSE_DAYS})`),
      ),
    )
    .orderBy(desc(intentSets.createdAt))
    .limit(1)
    .then(([row]) => row ?? null);
}

// The config hash is part of the claim, so a deploy with new prompts never waits on an old one.
const claimName = (key: IntentSetKey) =>
  `${key.categoryKey}|${key.scope}|${key.registerProfile}|${key.language}|${languageConfigHash(key.language)}`;

/** Takes the claim when it is free or its holder died; true when this caller now holds it. */
function claim(name: string, deadlineAt: number): Promise<boolean> {
  const expiresAt = new Date(deadlineAt + CLAIM_MARGIN_MS);
  return withSystem(REASON, async (tx) => {
    const taken = await tx
      .insert(intentSetClaims)
      .values({ key: name, expiresAt })
      .onConflictDoUpdate({
        target: intentSetClaims.key,
        set: { expiresAt },
        setWhere: lt(intentSetClaims.expiresAt, sql`now()`),
      })
      .returning({ key: intentSetClaims.key });
    return taken.length > 0;
  });
}

const release = (tx: SystemTx, name: string) =>
  tx.delete(intentSetClaims).where(eq(intentSetClaims.key, name));

/** Stores the set; with a claim, the row appears and the claim goes in one commit. */
async function store(draft: IntentSetDraft, claimed?: string): Promise<IntentSet> {
  const set = sealIntentSet(draft);
  const { manifest } = set;
  if (stored.has(manifest.id) && claimed === undefined) return remember(set);
  const { sha256 } = await putArtifact("intent-sets", intentSetBytes(draft), {
    contentType: CONTENT_TYPE,
  });
  const row = {
    setId: manifest.id,
    kind: manifest.kind,
    version: manifest.version,
    categoryKey: manifest.categoryKey,
    scope: manifest.scope,
    registerProfile: manifest.registerProfile,
    language: setLanguage(set),
    generators: manifest.generators,
    variantCount: manifest.variantCount,
    contentHash: Buffer.from(manifest.contentHash, "hex"),
    merkleRoot: Buffer.from(manifest.merkleRoot, "hex"),
    generatorConfigHash:
      manifest.generatorConfigHash === null
        ? null
        : Buffer.from(manifest.generatorConfigHash, "hex"),
    artifactSha256: Buffer.from(sha256, "hex"),
  };
  await withSystem(REASON, async (tx) => {
    await tx.insert(intentSets).values(row).onConflictDoNothing();
    if (claimed !== undefined) await release(tx, claimed);
  });
  stored.add(manifest.id);
  return remember(set);
}

type Generation = GenerateIntentSetInput & { key: IntentSetKey };

async function generateClaimed(input: Generation, name: string): Promise<IntentSet> {
  try {
    // A holder that finished between our lookup and our claim left its set behind.
    const row = await withSystem(REASON, (tx) => reusable(tx, input.key), { readOnly: true });
    if (row) {
      await withSystem(REASON, (tx) => release(tx, name));
      return readStored(row.setId, row.artifactSha256);
    }
    const { set } = await generateIntentSet(input);
    return await store(set, name);
  } catch (error) {
    await withSystem(REASON, (tx) => release(tx, name)).catch(() => undefined);
    throw error;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One caller per key generates, holding a committed claim rather than a connection; the others
 * poll until the deadline. A claim gone with no set behind it means the holder fell back, so the
 * waiter takes the same deterministic template rather than paying for a second try.
 */
async function generateOnce(input: Generation): Promise<IntentSet> {
  const { key, category, scope, registerProfile, language, deadlineAt } = input;
  const name = claimName(key);
  if (await claim(name, deadlineAt)) return generateClaimed(input, name);

  while (Date.now() < deadlineAt) {
    await sleep(Math.min(POLL_MS, deadlineAt - Date.now()));
    // The claim is read first: the holder drops it in the commit that adds the set, so a claim
    // seen gone means the set, if any, is visible to the read after it.
    const state = await withSystem(
      REASON,
      async (tx) => {
        const [held] = await tx
          .select({ expired: sql<boolean>`${intentSetClaims.expiresAt} < now()` })
          .from(intentSetClaims)
          .where(eq(intentSetClaims.key, name));
        const row = await reusable(tx, key);
        if (row) return row;
        if (held === undefined) return "fell_back" as const;
        return held.expired ? ("expired" as const) : null;
      },
      { readOnly: true },
    );
    if (state === "fell_back") break;
    if (state === "expired") {
      if (await claim(name, deadlineAt)) return generateClaimed(input, name);
    } else if (state) {
      return readStored(state.setId, state.artifactSha256);
    }
  }
  return store(templateIntentSet(category, scope, registerProfile, language));
}

/**
 * The questions a business is measured with: the reviewed seed when it covers the category, else
 * a set generated for its category within the last 30 days, else a new one generated once for
 * every concurrent caller. Generation failures and the deadline fall back to the reviewed
 * templates, never to an error; a gendered language without the noun's gender is refused.
 */
export async function resolveIntentSet(input: ResolveIntentSetInput): Promise<IntentSet> {
  const { category, geo, scope } = input;
  const language = input.language ?? countryLanguage(geo.country);
  // The house country's speech is measured in its own register; every other one shares neutral.
  const registerProfile = geo.country === DEFAULT_COUNTRY_CODE ? "co" : "neutral";
  const key: IntentSetKey = { categoryKey: category.key, scope, registerProfile, language };
  const seeded = seed();
  const fromSeed = seeded && seedSetFor(seeded, key);
  if (fromSeed) return fromSeed;

  const noun = requireNounGender(input.noun ?? category.noun, language);
  const row = await withSystem(REASON, (tx) => reusable(tx, key), { readOnly: true });
  if (row) return readStored(row.setId, row.artifactSha256);
  return generateOnce({
    key,
    category,
    scope,
    registerProfile,
    language,
    noun,
    ...(input.synonyms && { synonyms: input.synonyms }),
    deadlineAt: input.deadlineAt,
    spend: input.spend,
  } as Generation);
}

async function setsById(setId: IntentSetId): Promise<Iterable<IntentSet>> {
  const seeded = seed();
  const first = seeded?.values().next().value;
  if (seeded && first?.manifest.id === setId) return seeded.values();
  const hit = cache.get(setId);
  if (hit) return [hit];
  const [row] = await withSystem(
    REASON,
    (tx) =>
      tx
        .select({ artifactSha256: intentSets.artifactSha256 })
        .from(intentSets)
        .where(eq(intentSets.setId, setId)),
    { readOnly: true },
  );
  if (!row) throw new NotFoundError(`intent set ${setId} does not exist`);
  return [await readStored(setId, row.artifactSha256)];
}

export async function getIntent(setId: IntentSetId, id: IntentId): Promise<Intent> {
  return findIntentIn(await setsById(setId), id);
}

/** The noun and neighborhood fill the prompt; the variant's id does not depend on either. */
export async function getVariant(
  setId: IntentSetId,
  id: VariantId,
  geoKey: GeoKey,
  context: { noun: Noun; neighborhood: string | null },
): Promise<PromptVariant> {
  return findVariantIn(await setsById(setId), id, getGeo(geoKey), context);
}

/**
 * The seed shipped with this build: its id, version and hashes are the frozen version's, shared by
 * every category in it; the category and scope are those of its first intent.
 */
export function currentSeedCatalog(): IntentSetManifest {
  const first = seed()?.values().next().value;
  if (!first) throw new AppError("internal", { detail: "no seed catalog version is frozen" });
  return first.manifest;
}
