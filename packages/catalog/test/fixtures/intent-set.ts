import type {
  CategoryArchetype,
  IntentSet,
  MeasurementLanguage,
  Paraphrase,
  Persona,
  QuestionScope,
} from "@reranker/schema/measurement";
import { contentHash, intentSetId } from "../../src/hash";
import { fallbackTemplates } from "../../src/templates";

const PERSONAS = ["parent", "senior", "student", "worker", "newcomer", "athlete"];

type SetShape = {
  archetype: CategoryArchetype;
  scope: QuestionScope;
  category: "dental_clinic" | "online_store";
  language: MeasurementLanguage;
};

/**
 * A set shaped like the seed: every template intent with its canonical as p00, the first five in
 * the free report and six personas, so each intent pools 9 × 7 = 63 variants.
 */
export function templateSet({ archetype, scope, category, language }: SetShape): IntentSet {
  const templates = fallbackTemplates(archetype, scope, language);
  const hash = contentHash({ templates, language });
  const id = intentSetId(hash);
  const intents = templates.map((t, index) => ({
    intentId: `${category}.${t.slug}` as const,
    intentSetId: id,
    categoryKey: category,
    scope,
    kind: t.kind,
    slug: t.slug,
    labelKey: null,
    canonicalText: t.canonical,
    canonicalParaphraseId: `${category}.${t.slug}.p00`,
    demandWeight: 1,
    freeReport: index < 5,
    language,
    registerProfile: "co" as const,
  }));
  const paraphrases: Paraphrase[] = templates.flatMap((t) =>
    [{ text: t.canonical, format: "open_question" as const }, ...t.paraphrases].map((p, i) => ({
      paraphraseId: `${category}.${t.slug}.p${String(i).padStart(2, "0")}`,
      intentId: `${category}.${t.slug}` as const,
      text: p.text,
      format: p.format,
      generator: "template" as const,
      humanReviewed: true,
    })),
  );
  const personas: Persona[] = PERSONAS.map((p) => ({
    personaId: `${category}.${p}`,
    categoryKey: category,
    preamble: language === "es" ? `Pregunto como ${p}.` : `Asking as a ${p}.`,
  }));
  return {
    manifest: {
      id,
      kind: "template",
      version: "2026.11.0",
      categoryKey: category,
      scope,
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

export function dentalSet(language: MeasurementLanguage = "es"): IntentSet {
  return templateSet({ archetype: "health", scope: "local", category: "dental_clinic", language });
}
