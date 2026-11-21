import { mainLanguage } from "@reranker/i18n/countries";
import { NotFoundError } from "@reranker/jobs/errors";
import { z } from "@reranker/schema";
import {
  type CategoryKey,
  type GeoTarget,
  Intent,
  type IntentId,
  IntentSet,
  IntentSetManifest,
  type MeasurementLanguage,
  Paraphrase,
  Persona,
  type PromptVariant,
  type QuestionScope,
  type RegisterProfile,
  type VariantId,
} from "@reranker/schema/measurement";
import type { IntentSetDraft } from "./generate/pipeline";
import type { Noun } from "./grammar";
import { contentHash, intentSetId, jcs, merkleRoot, variantId, variantTemplates } from "./hash";
import type { FrozenSeed } from "./seed/load";
import { materialize, variantContext, variantPool } from "./variants";

/** What makes two businesses share a set. */
export type IntentSetKey = {
  categoryKey: CategoryKey;
  scope: QuestionScope;
  registerProfile: RegisterProfile;
  language: MeasurementLanguage;
};

const StoredDraft = z.object({
  manifest: IntentSetManifest.omit({ id: true, contentHash: true, merkleRoot: true }),
  intents: z.array(Intent.omit({ intentSetId: true })).min(1),
  paraphrases: z.array(Paraphrase),
  personas: z.array(Persona),
});

/**
 * The stored form of a set is its draft as canonical JSON, so the artifact's digest is the set's
 * content hash and anyone holding the bytes can recompute its id.
 */
export function intentSetBytes(draft: IntentSetDraft): Uint8Array {
  return jcs(draft);
}

export function sealIntentSet(draft: IntentSetDraft): IntentSet {
  const hash = contentHash(draft);
  const id = intentSetId(hash);
  return IntentSet.parse({
    manifest: {
      ...draft.manifest,
      id,
      contentHash: hash,
      merkleRoot: merkleRoot(variantTemplates(draft)),
    },
    intents: draft.intents.map((intent) => ({ ...intent, intentSetId: id })),
    paraphrases: draft.paraphrases,
    personas: draft.personas,
  });
}

export function openIntentSet(bytes: Uint8Array): IntentSet {
  return sealIntentSet(StoredDraft.parse(JSON.parse(new TextDecoder().decode(bytes))));
}

const keyOf = (k: IntentSetKey) => `${k.categoryKey}|${k.scope}|${k.registerProfile}|${k.language}`;

/**
 * The seed as one set per key, each under the seed version's id and hashes: a capture proves its
 * question against the frozen version, not against a slice of it.
 */
export function seedIntentSets(seed: FrozenSeed): ReadonlyMap<string, IntentSet> {
  const id = intentSetId(seed.contentHash);
  const groups = Map.groupBy(seed.catalog.intents, keyOf);
  return new Map(
    [...groups].map(([key, intents]) => {
      const [{ categoryKey, scope, registerProfile }] = intents as [(typeof intents)[number]];
      const ids = new Set(intents.map((i) => i.intentId));
      const set: IntentSet = {
        manifest: {
          id,
          kind: "seed",
          version: seed.version,
          categoryKey,
          scope,
          registerProfile,
          contentHash: seed.contentHash,
          merkleRoot: seed.merkleRoot,
          variantCount: seed.variantCount,
          generatorConfigHash: null,
          generators: 0,
        },
        intents: intents.map((intent) => ({ ...intent, intentSetId: id })),
        paraphrases: seed.catalog.paraphrases.filter((p) => ids.has(p.intentId)),
        personas: seed.catalog.personas.filter((p) => p.categoryKey === categoryKey),
      };
      return [key, set];
    }),
  );
}

export function seedSetFor(sets: ReadonlyMap<string, IntentSet>, key: IntentSetKey) {
  return sets.get(keyOf(key)) ?? null;
}

export function findIntentIn(sets: Iterable<IntentSet>, id: IntentId): Intent {
  for (const set of sets) {
    const intent = set.intents.find((i) => i.intentId === id);
    if (intent) return intent;
  }
  throw new NotFoundError(`intent ${id} is not in the set`);
}

/**
 * A variant by id at a place. Ids are computed before any prompt is filled, so a zone question
 * the business cannot be asked does not stop a lookup of another variant.
 */
export function findVariantIn(
  sets: Iterable<IntentSet>,
  id: VariantId,
  geo: GeoTarget,
  context: { noun: Noun; neighborhood: string | null },
): PromptVariant {
  for (const set of sets) {
    for (const intent of set.intents) {
      const { intentId, language } = intent;
      const named = language === mainLanguage(geo.country) ? {} : { language };
      const match = variantPool(set, intent).find(
        (c) =>
          variantId({
            intentId,
            paraphraseId: c.paraphraseId,
            personaId: c.personaId,
            geoKey: geo.key,
            ...named,
          }) === id,
      );
      if (match) {
        const ctx = variantContext(geo, intent.scope, context.neighborhood, context.noun, language);
        return materialize(intentId, match, geo, ctx, language);
      }
    }
  }
  throw new NotFoundError(`variant ${id} is not in the set at ${geo.key}`);
}
