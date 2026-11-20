import type { IntentSet, Paraphrase, Persona } from "@reranker/schema/measurement";
import { contentHash, intentSetId } from "../../src/hash";
import { fallbackTemplates } from "../../src/templates";

const PERSONAS = ["parent", "senior", "student", "worker", "newcomer", "athlete"];

/**
 * A dental clinic set shaped like the seed: every template intent with its canonical as p00,
 * the first five in the free report and six personas, so each intent pools 9 × 7 = 63 variants.
 */
export function dentalSet(): IntentSet {
  const templates = fallbackTemplates("health", "local");
  const hash = contentHash(templates);
  const id = intentSetId(hash);
  const intents = templates.map((t, index) => ({
    intentId: `dental_clinic.${t.slug}` as const,
    intentSetId: id,
    categoryKey: "dental_clinic" as const,
    scope: "local" as const,
    kind: t.kind,
    slug: t.slug,
    labelKey: null,
    canonicalText: t.canonical,
    canonicalParaphraseId: `dental_clinic.${t.slug}.p00`,
    demandWeight: 1,
    freeReport: index < 5,
    language: "es" as const,
    registerProfile: "co" as const,
  }));
  const paraphrases: Paraphrase[] = templates.flatMap((t) =>
    [{ text: t.canonical, format: "open_question" as const }, ...t.paraphrases].map((p, i) => ({
      paraphraseId: `dental_clinic.${t.slug}.p${String(i).padStart(2, "0")}`,
      intentId: `dental_clinic.${t.slug}` as const,
      text: p.text,
      format: p.format,
      generator: "template" as const,
      humanReviewed: true,
    })),
  );
  const personas: Persona[] = PERSONAS.map((p) => ({
    personaId: `dental_clinic.${p}`,
    categoryKey: "dental_clinic",
    preamble: `Pregunto como ${p}.`,
  }));
  return {
    manifest: {
      id,
      kind: "template",
      version: "2026.11.0",
      categoryKey: "dental_clinic",
      scope: "local",
      registerProfile: "co",
      contentHash: hash,
      merkleRoot: hash,
      variantCount: paraphrases.length * (PERSONAS.length + 1),
      generatorConfigHash: null,
      generators: 0,
    },
    intents,
    paraphrases,
    personas,
  };
}
