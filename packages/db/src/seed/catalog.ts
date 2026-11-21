import { AppError } from "@reranker/schema";
import type { SeedCatalogFile } from "@reranker/schema/measurement";
import { eq } from "drizzle-orm";
import { categories, intents, paraphrases, personas, promptSets } from "../schema/catalog";
import { withSystem } from "../tenancy";

export type SeedCatalogInput = {
  version: string;
  catalog: SeedCatalogFile;
  contentHash: string;
  merkleRoot: string;
};

// Every paraphrase pairs with none and with each persona of its category speaking its language
// and profile, as the catalog's variant templates do.
function variantCount(catalog: SeedCatalogFile): number {
  const speech = (p: { categoryKey: string; language: string; registerProfile: string }) =>
    `${p.categoryKey}|${p.language}|${p.registerProfile}`;
  const personasPer = new Map<string, number>();
  for (const persona of catalog.personas) {
    personasPer.set(speech(persona), (personasPer.get(speech(persona)) ?? 0) + 1);
  }
  const speechOf = new Map(catalog.intents.map((intent) => [intent.intentId, speech(intent)]));
  return catalog.paraphrases.reduce((sum, paraphrase) => {
    const key = speechOf.get(paraphrase.intentId);
    return sum + (key === undefined ? 0 : (personasPer.get(key) ?? 0) + 1);
  }, 0);
}

/**
 * Mirrors a frozen seed version into public_panel. Rows already present are left untouched, so a
 * deploy can run it on every release; a version that was frozen with other content fails.
 */
export async function seedCatalog(input: SeedCatalogInput): Promise<{ inserted: number }> {
  const { version, catalog } = input;
  const contentHash = Buffer.from(input.contentHash, "hex");
  return withSystem("catalog-seed", async (tx) => {
    const promptSetRows = await tx
      .insert(promptSets)
      .values({
        version,
        contentHash,
        merkleRoot: Buffer.from(input.merkleRoot, "hex"),
        variantCount: variantCount(catalog),
      })
      .onConflictDoNothing()
      .returning({ id: promptSets.id });

    const [stored] = await tx
      .select({ contentHash: promptSets.contentHash })
      .from(promptSets)
      .where(eq(promptSets.version, version));
    if (!stored?.contentHash.equals(contentHash)) {
      throw new AppError("internal", {
        detail: `seed version ${version} is already frozen with another content hash`,
      });
    }

    const categoryRows = await tx
      .insert(categories)
      .values(
        catalog.categories.map((category) => ({
          key: category.key,
          labelKey: category.labelKey,
          archetype: category.archetype,
          placesTypes: category.placesTypes,
          defaultScope: category.defaultScope,
          register: category.register,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: categories.id });

    const intentRows = await tx
      .insert(intents)
      .values(
        catalog.intents.map((intent) => ({
          promptSet: version,
          intentId: intent.intentId,
          category: intent.categoryKey,
          kind: intent.kind,
          slug: intent.slug,
          labelKey: intent.labelKey,
          demandWeight: intent.demandWeight,
          freeReport: intent.freeReport,
          canonicalParaphraseId: intent.canonicalParaphraseId,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: intents.id });

    const personaRows =
      catalog.personas.length === 0
        ? []
        : await tx
            .insert(personas)
            .values(
              catalog.personas.map((persona) => ({
                promptSet: version,
                personaId: persona.personaId,
                category: persona.categoryKey,
                preamble: persona.preamble,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: personas.id });

    const paraphraseRows = await tx
      .insert(paraphrases)
      .values(
        catalog.paraphrases.map((paraphrase) => ({
          promptSet: version,
          paraphraseId: paraphrase.paraphraseId,
          intentId: paraphrase.intentId,
          text: paraphrase.text,
          format: paraphrase.format,
          generator: paraphrase.generator,
          humanReviewed: paraphrase.humanReviewed,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: paraphrases.id });

    return {
      inserted:
        promptSetRows.length +
        categoryRows.length +
        intentRows.length +
        personaRows.length +
        paraphraseRows.length,
    };
  });
}
