import { isEnabled } from "@reranker/flags";
import type { SpendContext } from "@reranker/jobs";
import type {
  BusinessCategory,
  Intent,
  IntentSetManifest,
  MeasurementLanguage,
  Paraphrase,
  Persona,
  QuestionScope,
  RegisterProfile,
} from "@reranker/schema/measurement";
import { agree, type GenderedLanguage, type GenderedNoun, type Noun, nounText } from "../grammar";
import { requireNounGender } from "../language";
import { type FallbackIntent, fallbackTemplates, templatesVersion } from "../templates";
import { GENERATOR_CONFIG, generatorConfigHash } from "./config";
import { type PoolReport, selectPool } from "./filter";
import {
  type Candidate,
  type GuardContext,
  type GuardName,
  guardParaphrase,
  guardPersona,
} from "./guards";
import { isGenerationLanguage } from "./prompts";
import { type DraftIntent, embed, generateParaphrases, judge } from "./providers";

/** A set before sealing: the content hash, Merkle root and ids are added when it is stored. */
export type IntentSetDraft = {
  manifest: Omit<IntentSetManifest, "id" | "contentHash" | "merkleRoot">;
  intents: Array<Omit<Intent, "intentSetId">>;
  paraphrases: Paraphrase[];
  personas: Persona[];
};

export type FallbackReason = "disabled" | "no_prompts" | "no_time" | "incomplete";

export interface FilterReport extends PoolReport {
  /** Paraphrases that came back from the providers, before any guard. */
  candidates: number;
  guards: Record<GuardName, number>;
  /** Intents with enough kept paraphrases to be sampled. */
  complete: number;
  fallback: FallbackReason | null;
}

interface GenerateIntentSetBase {
  /** Its label and noun are in the set's language, as people asking in it name the business. */
  category: BusinessCategory;
  /** Other names the guards accept for the category's noun, in the set's language. */
  synonyms?: string[];
  scope: QuestionScope;
  registerProfile: RegisterProfile;
  deadlineAt: number;
  spend: SpendContext;
}

/**
 * Where templates agree with the noun (pt, fr, de, it) the noun and its gender are required; in
 * the other languages the category's bare noun is used unless one is given.
 */
export type GenerateIntentSetInput = GenerateIntentSetBase &
  (
    | { language: Exclude<MeasurementLanguage, GenderedLanguage>; noun?: Noun }
    | { language: GenderedLanguage; noun: GenderedNoun }
  );

export interface GeneratedIntentSet {
  set: IntentSetDraft;
  report: FilterReport;
  outcome: "generated" | "template";
  generators: 0 | 1 | 2;
}

const PROVIDERS = ["openai", "gemini"] as const;
// Margin for sealing and returning after the last call.
const SAFETY_MS = 250;
// Embedding plus six parallel judge calls at low reasoning.
const FILTER_RESERVE_MS = 3000;
// Below this, paraphrase calls cannot finish: money spent for a set that falls back anyway.
const MIN_GENERATION_MS = 1000;
const NO_NAMES: ReadonlySet<string> = new Set();

type Kept = { text: string; format: Paraphrase["format"]; generator: Paraphrase["generator"] };

function emptyReport(fallback: FallbackReason | null): FilterReport {
  const guards = {
    placeholder: 0,
    category_noun: 0,
    proper_name: 0,
    qualifier: 0,
    length: 0,
    personal_data: 0,
  };
  return {
    candidates: 0,
    guards,
    dedupe: 0,
    offCentroid: 0,
    judge: 0,
    quota: 0,
    complete: 0,
    fallback,
  };
}

function draftSet(
  input: Pick<GenerateIntentSetInput, "category" | "scope" | "registerProfile" | "language">,
  intents: ReadonlyArray<{ template: FallbackIntent; kept: Kept[] }>,
  preambles: readonly string[],
  manifest: Pick<IntentSetManifest, "kind" | "version" | "generatorConfigHash" | "generators">,
): IntentSetDraft {
  const { category, scope, registerProfile, language } = input;
  const personas = preambles.map((preamble, i) => ({
    personaId: `${category.key}.persona_${i + 1}`,
    categoryKey: category.key,
    preamble,
  }));
  const paraphrases: Paraphrase[] = [];
  const rows = intents.map(({ template, kept }, index) => {
    const intentId = `${category.key}.${template.slug}` as const;
    const canonical = {
      text: template.canonical,
      format: "open_question",
      generator: "template",
    } as const;
    [canonical, ...kept].forEach((p, i) => {
      paraphrases.push({
        paraphraseId: `${intentId}.p${String(i).padStart(2, "0")}`,
        intentId,
        text: p.text,
        format: p.format,
        generator: p.generator,
        humanReviewed: p.generator === "template",
      });
    });
    return {
      intentId,
      categoryKey: category.key,
      scope,
      kind: template.kind,
      slug: template.slug,
      labelKey: null,
      canonicalText: template.canonical,
      canonicalParaphraseId: `${intentId}.p00`,
      demandWeight: 1,
      freeReport: index < GENERATOR_CONFIG.complete,
      language,
      registerProfile,
    };
  });
  return {
    manifest: {
      ...manifest,
      categoryKey: category.key,
      scope,
      registerProfile,
      variantCount: paraphrases.length * (personas.length + 1),
    },
    intents: rows,
    paraphrases,
    personas,
  };
}

/** The archetype's reviewed templates in `language`: what is asked when generation cannot be. */
export function templateIntentSet(
  category: BusinessCategory,
  scope: QuestionScope,
  registerProfile: RegisterProfile,
  language: MeasurementLanguage,
): IntentSetDraft {
  const intents = fallbackTemplates(category.archetype, scope, language).map((template) => ({
    template,
    kept: template.paraphrases.map((p) => ({ ...p, generator: "template" as const })),
  }));
  return draftSet({ category, scope, registerProfile, language }, intents, [], {
    kind: "template",
    version: templatesVersion(language),
    generatorConfigHash: null,
    generators: 0,
  });
}

// Providers honor the signal, but the deadline must hold even for one that does not.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Writes an intent set for a category outside the seed in `language`: both providers paraphrase
 * every intent of the archetype's slate in parallel, guards drop what breaks the rules, one
 * embedding call and a judge call per intent filter the rest, and the set is kept when at least
 * five intents come out complete. Anything short of that, a kill switch, a language without
 * reviewed prompts or no time left yields the language's own templates; it only throws for a
 * language that has no templates, or a gendered language given a noun without its gender.
 */
export async function generateIntentSet(
  input: GenerateIntentSetInput,
): Promise<GeneratedIntentSet> {
  const { category, scope, registerProfile, language, deadlineAt } = input;
  const slate = fallbackTemplates(category.archetype, scope, language);
  // Checked at runtime too: callers outside TypeScript's reach must not get a masculine default.
  const gendered = requireNounGender(input.noun ?? category.noun, language);
  const fallback = (reason: FallbackReason, report = emptyReport(reason)): GeneratedIntentSet => ({
    set: templateIntentSet(category, scope, registerProfile, language),
    report: { ...report, fallback: reason },
    outcome: "template",
    generators: 0,
  });

  if (!isGenerationLanguage(language)) return fallback("no_prompts");
  const filterEnd = deadlineAt - SAFETY_MS;
  const generationEnd = filterEnd - FILTER_RESERVE_MS;
  if (generationEnd - Date.now() < MIN_GENERATION_MS) return fallback("no_time");
  if (!(await isEnabled("intent-generation", { kind: "system" }))) return fallback("disabled");

  const noun = nounText(gendered);
  const synonyms = input.synonyms ?? [];
  // requireNounGender holds the noun to its language, which the mapped DraftIntent type cannot see.
  const drafts = slate.map(
    (t) =>
      ({
        category: { ...category, noun },
        noun: gendered,
        scope,
        kind: t.kind,
        slug: t.slug,
        canonicalText: agree(t.canonical, gendered, language).replaceAll("{sustantivo}", noun),
        language,
        registerProfile,
      }) as DraftIntent,
  );
  const generation = {
    spend: input.spend,
    signal: AbortSignal.timeout(Math.max(0, generationEnd - Date.now())),
    deadlineAt: generationEnd,
  };
  const answers = await Promise.allSettled(
    drafts.flatMap((intent) =>
      PROVIDERS.map((provider) =>
        untilAborted(
          generateParaphrases(
            provider,
            { intent, register: registerProfile, withPersonas: intent.kind === "discovery" },
            generation,
          ),
          generation.signal,
        ),
      ),
    ),
  );
  const received = drafts.map((_, i) =>
    PROVIDERS.flatMap((_, p) => {
      const answer = answers[i * PROVIDERS.length + p];
      return answer?.status === "fulfilled" ? [answer.value] : [];
    }),
  );

  const report = emptyReport(null);
  const guard = (kind: DraftIntent["kind"]): GuardContext => ({
    scope,
    kind,
    language,
    noun,
    synonyms,
    // The set is shared by every country of its profile, so it names none: {país} stands in.
    countryName: "",
    otherPlaceNames: NO_NAMES,
    blockedNames: NO_NAMES,
  });
  const accepted = drafts.map((intent, i) => {
    const seen = new Set([intent.canonicalText]);
    return (received[i] ?? []).flatMap(({ paraphrases }) =>
      paraphrases.filter((c) => {
        report.candidates++;
        if (seen.has(c.text)) {
          report.dedupe++;
          return false;
        }
        seen.add(c.text);
        const verdict = guardParaphrase(c, guard(intent.kind));
        if (!verdict.ok) report.guards[verdict.guard]++;
        return verdict.ok;
      }),
    );
  });
  const pooled = accepted.flat();
  if (pooled.length === 0) return fallback("incomplete", report);

  const filtering = {
    spend: input.spend,
    signal: AbortSignal.timeout(Math.max(0, filterEnd - Date.now())),
    deadlineAt: filterEnd,
  };
  let embeddings: Float32Array[];
  try {
    embeddings = await untilAborted(
      embed(
        pooled.map((c) => c.text),
        filtering,
      ),
      filtering.signal,
    );
  } catch {
    return fallback("incomplete", report);
  }
  const verdicts = await Promise.allSettled(
    drafts.map((intent, i) =>
      untilAborted(judge(intent, accepted[i] ?? [], filtering), filtering.signal),
    ),
  );

  let offset = 0;
  const complete: Array<{ template: FallbackIntent; kept: Candidate[] }> = [];
  drafts.forEach((_, i) => {
    const candidates = accepted[i] ?? [];
    const verdict = verdicts[i];
    const pool = selectPool({
      candidates,
      embeddings: embeddings.slice(offset, offset + candidates.length),
      judged: verdict?.status === "fulfilled" ? verdict.value : candidates.map(() => false),
      keep: GENERATOR_CONFIG.keep,
      minPerFormat: GENERATOR_CONFIG.minPerFormat,
    });
    offset += candidates.length;
    for (const key of ["dedupe", "offCentroid", "judge", "quota"] as const)
      report[key] += pool.report[key];
    const template = slate[i];
    if (template && pool.kept.length >= GENERATOR_CONFIG.minVariants) {
      complete.push({ template, kept: pool.kept });
    }
  });
  report.complete = complete.length;
  if (complete.length < GENERATOR_CONFIG.complete) return fallback("incomplete", report);

  const discovery = drafts.findIndex((d) => d.kind === "discovery");
  const preambles = [...new Set((received[discovery] ?? []).flatMap((answer) => answer.personas))]
    .filter((p) => guardPersona(p, guard("discovery")).ok)
    .slice(0, GENERATOR_CONFIG.personas);
  const generators = new Set(complete.flatMap((c) => c.kept.map((k) => k.generator))).size as 1 | 2;
  const set = draftSet(input, complete, preambles, {
    kind: "generated",
    version: new Date().toISOString().slice(0, 10),
    generatorConfigHash,
    generators,
  });
  return { set, report, outcome: "generated", generators };
}
