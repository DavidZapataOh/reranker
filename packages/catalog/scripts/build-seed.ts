/**
 * Writes the candidate pool of one seed group (a language and speech profile): for every seed
 * category, its archetype's six template intents plus two of its own, each paraphrased by both
 * providers, guarded, embedded and judged until it has a ranked pool to choose 29 paraphrases
 * from after review. Nothing here is shipped: reviews pick from this pool and freezing assembles
 * the catalog.
 *
 * Usage: pnpm --filter @reranker/catalog seed:build <language> <profile> <empty output dir>
 * Charged to the spend ledger as `benchmark`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { endPools } from "@reranker/db";
import { costOf as ledgerCost, type SpendContext } from "@reranker/jobs";
import { z } from "@reranker/schema";
import {
  IntentKind,
  MeasurementLanguage,
  type ParaphraseFormat,
  RegisterProfile,
  SeedCategoryKey,
} from "@reranker/schema/measurement";
import sourcesJson from "../data/seed-sources/2026.11.0.json" with { type: "json" };
import { type SeedCategory, seedCategories } from "../src/categories";
import { generatorConfigHash } from "../src/generate/config";
import { centroid, cosine, selectPool } from "../src/generate/filter";
import {
  type Candidate,
  type GuardContext,
  type GuardName,
  guardParaphrase,
  guardPersona,
} from "../src/generate/guards";
import { type DraftIntent, embed, generateParaphrases, judge } from "../src/generate/providers";
import type { CallContext } from "../src/generate/spend";
import { AGREEMENT, agree, isGendered, type Noun, nounText } from "../src/grammar";
import { fallbackTemplates } from "../src/templates";

export type SeedGroup = { language: MeasurementLanguage; registerProfile: RegisterProfile };

/** Spanish is asked in Colombia's speech and in the neutral one; every other language in neutral. */
export const SEED_GROUPS: readonly SeedGroup[] = [
  { language: "es", registerProfile: "co" },
  { language: "es", registerProfile: "neutral" },
  ...(["en", "pt", "fr", "de", "it"] as const).map((language) => ({
    language,
    registerProfile: "neutral" as const,
  })),
];

const PROVIDERS = ["openai", "gemini"] as const;
const PER_CALL = 25;
const PERSONAS_PER_CALL = 6;
/** 29 paraphrases beside the canonical, plus reserves that replace what review rejects. */
export const POOL_TARGET = 40;
export const MIN_PER_FORMAT = 6;
const MAX_ROUNDS = 3;
const FREE_REPORT = 5;
const CALL_MS = 120_000;

const Canonical = z.string().min(1);
const Sources = z.object({
  version: z.string(),
  extras: z.record(
    SeedCategoryKey,
    z
      .array(
        z.object({
          kind: IntentKind,
          slug: z.string().regex(/^[a-z]+(?:_[a-z]+)*$/),
          canonical: z.object({
            es: z.union([Canonical, z.object({ co: Canonical, neutral: Canonical })]),
            en: Canonical,
            pt: Canonical,
            fr: Canonical,
            de: Canonical,
            it: Canonical,
          }),
        }),
      )
      .length(2),
  ),
});
const SOURCES = Sources.parse(sourcesJson);

export const groupKey = (g: SeedGroup) => `${g.language}-${g.registerProfile}`;

export type SeedIntentPlan = {
  intentId: `${string}.${string}`;
  kind: IntentKind;
  slug: string;
  labelKey: string;
  freeReport: boolean;
  /** With the template placeholders and agreement groups, filled when a variant is built. */
  canonical: string;
};

/**
 * The noun and synonyms as people asking in the language say them. A web-only store names what it
 * sells, so its questions keep {sustantivo}; its templates agree with nothing.
 */
export function namesFor(
  category: Readonly<SeedCategory>,
  language: MeasurementLanguage,
): { noun: Noun; synonyms: string[] } {
  const names =
    language === "es"
      ? { noun: category.noun, synonyms: category.synonyms }
      : category.languages[language];
  if (names.noun !== null) return { noun: names.noun, synonyms: names.synonyms };
  const placeholder = "{sustantivo}";
  return {
    noun: isGendered(language) ? { text: placeholder, gender: "m" } : placeholder,
    synonyms: names.synonyms,
  };
}

/** The canonical as the providers read it: its words agree with the noun, which fills it. */
export function fillCanonical(canonical: string, noun: Noun, language: MeasurementLanguage) {
  // A template without agreement groups needs no grammar, and the store's placeholder has none.
  const agreed = canonical.search(AGREEMENT) === -1 ? canonical : agree(canonical, noun, language);
  return agreed.replaceAll("{sustantivo}", nounText(noun));
}

/**
 * The archetype's six template intents in slate order, the first five in the free report, then the
 * category's two own ones. Ids carry the group, since every group shares the version's set id;
 * label keys carry only the meaning, shared by every group.
 */
export function groupIntents(category: Readonly<SeedCategory>, group: SeedGroup): SeedIntentPlan[] {
  const prefix = groupKey(group);
  const slate = fallbackTemplates(category.archetype, category.defaultScope, group.language).map(
    (t) => ({ kind: t.kind, meaning: t.kind, canonical: t.canonical }),
  );
  const extras = SOURCES.extras[category.key].map((x) => {
    const text = x.canonical[group.language];
    return {
      kind: x.kind,
      meaning: x.slug,
      canonical: typeof text === "string" ? text : text[group.registerProfile],
    };
  });
  return [...slate, ...extras].map(({ kind, meaning, canonical }, i) => ({
    intentId: `${category.key}.${prefix}-${meaning.replaceAll("_", "-")}`,
    kind,
    slug: `${prefix}-${meaning.replaceAll("_", "-")}`,
    labelKey: `catalog.intents.${category.key}.${meaning}`,
    freeReport: i < FREE_REPORT,
    canonical,
  }));
}

type Deps = {
  generate: typeof generateParaphrases;
  embed: typeof embed;
  judge: typeof judge;
};

export type PoolEntry = Candidate & { closeness: number };

export type IntentPool = SeedIntentPlan & {
  pool: PoolEntry[];
  report: {
    candidates: number;
    guards: Record<GuardName, number>;
    dedupe: number;
    offCentroid: number;
    judge: number;
    rounds: number;
    /** The closest two pooled paraphrases; dedupe keeps it under 0.90. */
    maxPairCosine: number;
    canonicalCloseness: number;
    /** 1 when the canonical is closer to the centroid than every pooled paraphrase. */
    canonicalRank: number;
  };
};

type Persona = { text: string; generator: (typeof PROVIDERS)[number] };

export type CategoryPool = {
  key: string;
  noun: Noun;
  synonyms: string[];
  intents: IntentPool[];
  /** Guarded and in the order they came, the reserves after the six a category keeps. */
  personas: Persona[];
};

const noGuards = (): Record<GuardName, number> => ({
  placeholder: 0,
  category_noun: 0,
  proper_name: 0,
  qualifier: 0,
  length: 0,
  personal_data: 0,
});

const callContext = (spend: SpendContext): CallContext => ({
  spend,
  signal: AbortSignal.timeout(CALL_MS),
  deadlineAt: Date.now() + CALL_MS,
});

function formatsShort(pool: readonly Candidate[]): boolean {
  const counts = new Map<ParaphraseFormat, number>();
  for (const c of pool) counts.set(c.format, (counts.get(c.format) ?? 0) + 1);
  return ["open_question", "list_request", "keyword", "constraint"].some(
    (f) => (counts.get(f as ParaphraseFormat) ?? 0) < MIN_PER_FORMAT,
  );
}

async function buildIntent(
  plan: SeedIntentPlan,
  draft: DraftIntent,
  guard: GuardContext,
  spend: SpendContext,
  deps: Deps,
  personas: Persona[],
): Promise<IntentPool> {
  const report = { candidates: 0, guards: noGuards(), dedupe: 0, rounds: 0 };
  const seen = new Set([draft.canonicalText]);
  const accepted: Candidate[] = [];
  const vectors: Float32Array[] = [];
  const verdicts: boolean[] = [];
  const [canonicalVector] = await deps.embed([draft.canonicalText], callContext(spend));
  let ranked: Candidate[] = [];
  let pooled = { dedupe: 0, offCentroid: 0, judge: 0 };

  while (report.rounds < MAX_ROUNDS && (ranked.length < POOL_TARGET || formatsShort(ranked))) {
    const withPersonas = report.rounds === 0 && plan.kind === "discovery";
    report.rounds++;
    const answers = await Promise.allSettled(
      PROVIDERS.map((provider) =>
        deps.generate(
          provider,
          {
            intent: draft,
            register: draft.registerProfile,
            withPersonas,
            count: PER_CALL,
            personas: PERSONAS_PER_CALL,
          },
          callContext(spend),
        ),
      ),
    );
    const fresh: Candidate[] = [];
    for (const [i, answer] of answers.entries()) {
      if (answer.status !== "fulfilled") continue;
      const generator = PROVIDERS[i] as Persona["generator"];
      personas.push(...answer.value.personas.map((text) => ({ text, generator })));
      for (const c of answer.value.paraphrases) {
        report.candidates++;
        if (seen.has(c.text)) {
          report.dedupe++;
          continue;
        }
        seen.add(c.text);
        const verdict = guardParaphrase(c, guard);
        if (verdict.ok) fresh.push(c);
        else report.guards[verdict.guard]++;
      }
    }
    if (fresh.length === 0) continue;
    const [embedded, judged] = await Promise.all([
      deps.embed(
        fresh.map((c) => c.text),
        callContext(spend),
      ),
      deps.judge(draft, fresh, callContext(spend)),
    ]);
    accepted.push(...fresh);
    vectors.push(...embedded);
    verdicts.push(...judged);
    const selected = selectPool({
      candidates: accepted,
      embeddings: vectors,
      judged: verdicts,
      keep: Number.MAX_SAFE_INTEGER,
      minPerFormat: 0,
    });
    ranked = selected.kept;
    pooled = selected.report;
  }

  const center = centroid(vectors);
  const vectorOf = new Map(accepted.map((c, i) => [c, vectors[i] as Float32Array]));
  const pool = ranked.map((c) => ({
    ...c,
    closeness: cosine(vectorOf.get(c) as Float32Array, center),
  }));
  let maxPairCosine = 0;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const pair = cosine(
        vectorOf.get(ranked[i] as Candidate) as Float32Array,
        vectorOf.get(ranked[j] as Candidate) as Float32Array,
      );
      maxPairCosine = Math.max(maxPairCosine, pair);
    }
  }
  const canonicalCloseness =
    vectors.length === 0 ? 0 : cosine(canonicalVector as Float32Array, center);
  return {
    ...plan,
    pool,
    report: {
      ...report,
      ...pooled,
      maxPairCosine,
      canonicalCloseness,
      canonicalRank: 1 + pool.filter((p) => p.closeness > canonicalCloseness).length,
    },
  };
}

export async function buildCategory(
  category: Readonly<SeedCategory>,
  group: SeedGroup,
  spend: SpendContext,
  deps: Deps = { generate: generateParaphrases, embed, judge },
): Promise<CategoryPool> {
  const { language, registerProfile } = group;
  const { noun, synonyms } = namesFor(category, language);
  const text = nounText(noun);
  const scope = category.defaultScope;
  const business = {
    key: category.key,
    source: "seed" as const,
    label: text,
    noun: text,
    archetype: category.archetype,
    scope,
    register: category.register,
    placesTypes: category.placesTypes,
  };
  const personas: Persona[] = [];
  const guardFor = (kind: IntentKind): GuardContext => ({
    scope,
    kind,
    language,
    noun: text,
    synonyms,
    countryName: "",
    otherPlaceNames: new Set(),
    blockedNames: new Set(),
  });
  const intents = await Promise.all(
    groupIntents(category, group).map((plan) => {
      const draft = {
        category: business,
        noun,
        scope,
        kind: plan.kind,
        slug: plan.slug,
        canonicalText: fillCanonical(plan.canonical, noun, language),
        language,
        registerProfile,
      } as DraftIntent;
      return buildIntent(plan, draft, guardFor(plan.kind), spend, deps, personas);
    }),
  );
  const seen = new Set<string>();
  const kept = personas.filter((p) => {
    if (seen.has(p.text)) return false;
    seen.add(p.text);
    return guardPersona(p.text, guardFor("discovery")).ok;
  });
  return { key: category.key, noun, synonyms, intents, personas: kept };
}

export type GroupPool = {
  version: string;
  language: MeasurementLanguage;
  registerProfile: RegisterProfile;
  generatorConfigHash: string;
  builtAt: string;
  costMicros: number;
  categories: CategoryPool[];
};

async function main(): Promise<void> {
  const [rawLanguage, rawProfile, rawOut] = process.argv.slice(2);
  const group = {
    language: MeasurementLanguage.parse(rawLanguage),
    registerProfile: RegisterProfile.parse(rawProfile),
  };
  if (!SEED_GROUPS.some((g) => groupKey(g) === groupKey(group))) {
    throw new Error(`${groupKey(group)} is not a seed group`);
  }
  if (!rawOut) throw new Error("usage: build-seed <language> <profile> <empty output dir>");
  const out = resolve(rawOut);
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length > 0) throw new Error(`${out} is not empty`);

  const spend = { purpose: "benchmark" as const, refType: "seed-build", refId: randomUUID() };
  const categories: CategoryPool[] = [];
  for (const category of seedCategories()) {
    const built = await buildCategory(category, group, spend);
    categories.push(built);
    for (const intent of built.intents) {
      console.log(`${intent.intentId}: ${intent.pool.length} pooled in ${intent.report.rounds}`);
    }
  }
  const { amount_micros: amountMicros } = await ledgerCost(spend.refType, spend.refId);
  const pool: GroupPool = {
    version: SOURCES.version,
    ...group,
    generatorConfigHash,
    builtAt: new Date().toISOString(),
    costMicros: amountMicros,
    categories,
  };
  writeFileSync(join(out, `seed-${groupKey(group)}.json`), `${JSON.stringify(pool, null, 2)}\n`);
  console.log(`${groupKey(group)}: US$${(amountMicros / 1e6).toFixed(4)}`);
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await endPools();
  }
}
