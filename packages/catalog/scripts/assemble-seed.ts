/**
 * Assembles a seed version from the built pools and their reviews: the founder's decisions for
 * the Spanish groups, the two-provider native review for the others. Only reviewed content ships:
 * a rejected canonical gives way to the closest approved open question, a rejected persona or
 * sampled paraphrase to the reserve approved in its place, and an intent below the floor leaves
 * the seed, its free-report place taken by the category's next full intent.
 *
 * Usage: pnpm --filter @reranker/catalog seed:assemble <builds dir> <native reviews dir>
 *   <Spanish decisions .json> <version>
 * Writes data/<version>/catalog.json and filter-report.json; `freeze <version>` registers them.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Paraphrase, SeedCatalogFile, SeedPersona } from "@reranker/schema/measurement";
import { seedCategories } from "../src/categories";
import type { GroupPool, IntentPool, PoolEntry } from "./build-seed";
import { groupKey } from "./build-seed";
import type { CategoryReview, Reviewed } from "./review-native";
import { type ReviewItem, reviewItems } from "./review-sample";
import { type IntentFit, intentFit, PERSONAS_PER_CATEGORY, planKept } from "./seed-pool";

const FREE_REPORT = 5;

/** Why the founder rejected an item, when he said; the review page offers these. */
export const REJECTION_REASONS = [
  "sounds_off",
  "spelling",
  "changes_question",
  "names_brand_or_place",
  "other",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type Decision = {
  item: string;
  step: number;
  text: string;
  verdict: "approve" | "reject";
  reason?: RejectionReason;
  note?: string;
};

type ReasonCounts = Partial<Record<RejectionReason | "none", number>>;

export type RejectionReport = {
  byReason: ReasonCounts;
  /** Per intent, or per category for personas. */
  byItem: Record<string, ReasonCounts>;
  /** Per intent kind, persona and canonical, where a cluster shows a rule to tighten. */
  byKind: Record<string, ReasonCounts>;
  notes: Array<{ item: string; note: string }>;
};

/** The founder's rejections counted by reason, per intent and per intent kind. */
export function rejectionReasons(
  pools: readonly GroupPool[],
  decided: readonly Decision[],
): RejectionReport {
  const items = new Map(reviewItems(pools).map((i) => [i.id, i]));
  const kindOf = new Map<string, string>(
    pools.flatMap((p) =>
      p.categories.flatMap((c) => c.intents.map((i) => [i.intentId, i.kind] as const)),
    ),
  );
  const report: RejectionReport = { byReason: {}, byItem: {}, byKind: {}, notes: [] };
  const add = (counts: ReasonCounts, reason: RejectionReason | "none") => {
    counts[reason] = (counts[reason] ?? 0) + 1;
  };
  for (const d of decided) {
    if (d.verdict !== "reject") continue;
    const item = items.get(d.item);
    if (!item) continue;
    const reason = d.reason ?? "none";
    const [key, kind] =
      item.kind === "persona"
        ? [`${item.group}:${item.id.split(":")[2]}:personas`, "persona"]
        : item.kind === "canonical"
          ? [item.intentIds[0] ?? item.id, "canonical"]
          : [item.intentId, kindOf.get(item.intentId) ?? "unknown"];
    report.byItem[key] = report.byItem[key] ?? {};
    report.byKind[kind] = report.byKind[kind] ?? {};
    for (const counts of [report.byReason, report.byItem[key], report.byKind[kind]]) {
      add(counts, reason);
    }
    if (d.note) report.notes.push({ item: d.item, note: d.note });
  }
  return report;
}

/** A reason given at least three times that makes up half of a kind's rejections. */
export function reasonClusters(
  report: RejectionReport,
): Array<{ kind: string; reason: string; count: number }> {
  return Object.entries(report.byKind).flatMap(([kind, counts]) => {
    const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
    return Object.entries(counts)
      .filter(([reason, n]) => reason !== "none" && (n ?? 0) >= 3 && (n ?? 0) * 2 >= total)
      .map(([reason, n]) => ({ kind, reason, count: n ?? 0 }));
  });
}

/** How a group's content was reviewed, asked the same way for both kinds of review. */
type Judge = {
  canonical(intent: IntentPool): boolean;
  /** The personas that ship, in order. */
  personas(category: string, pooled: readonly { text: string }[]): string[];
  /** The paraphrases that ship from the planned 29, with replacements in place. */
  paraphrases(intent: IntentPool): PoolEntry[];
  humanReviewed(text: string): boolean;
};

/** The text a reviewed chain settled on: the approved step, or null when every step was rejected. */
function settled(item: ReviewItem, decisions: ReadonlyMap<string, Decision>): string | null {
  for (let step = 0; ; step++) {
    const d = decisions.get(step === 0 ? item.id : `${item.id}~r${step}`);
    if (!d) return null;
    if (d.verdict === "approve") return d.text;
  }
}

export function founderJudge(pools: readonly GroupPool[], decided: readonly Decision[]) {
  const decisions = new Map(
    decided.map((d) => [d.step === 0 ? d.item : `${d.item}~r${d.step}`, d] as const),
  );
  const items = reviewItems(pools);
  const missing = items.filter((i) => !decisions.has(i.id));
  if (missing.length > 0) {
    throw new Error(`${missing.length} review items have no decision, first ${missing[0]?.id}`);
  }
  const reviewed = new Set<string>();
  for (const d of decided) if (d.verdict === "approve") reviewed.add(d.text);
  return (group: string): Judge => ({
    canonical: (intent) => {
      const item = items.find(
        (i) => i.kind === "canonical" && i.intentIds.includes(intent.intentId),
      );
      return item !== undefined && decisions.get(item.id)?.verdict === "approve";
    },
    personas: (category) =>
      items
        .filter((i) => i.kind === "persona" && i.group === group && i.id.split(":")[2] === category)
        .flatMap((i) => settled(i, decisions) ?? []),
    paraphrases: (intent) => {
      const kept = planKept(intent.pool);
      const byText = new Map(intent.pool.map((p) => [p.text, p]));
      const sampled = items.filter(
        (i): i is Extract<ReviewItem, { kind: "paraphrase" }> =>
          i.kind === "paraphrase" && i.intentId === intent.intentId,
      );
      const swap = new Map(sampled.map((i) => [i.text, settled(i, decisions)]));
      return kept.flatMap((p) => {
        if (!swap.has(p.text)) return [p];
        const text = swap.get(p.text);
        const entry = text == null ? undefined : byText.get(text);
        return entry ? [entry] : [];
      });
    },
    humanReviewed: (text) => reviewed.has(text),
  });
}

export function nativeJudge(reviews: readonly CategoryReview[]): Judge {
  const passed = (items: readonly Reviewed[]) =>
    new Set(items.filter((r) => r.pass).map((r) => r.text));
  const canonicals = new Set(
    reviews.flatMap((r) => r.canonicals.filter((c) => c.pass).map((c) => c.intentId)),
  );
  const personas = new Map(reviews.map((r) => [r.key, passed(r.personas)]));
  const paraphrases = new Map(
    reviews.flatMap((r) => r.intents.map((i) => [i.intentId, passed(i.paraphrases)])),
  );
  return {
    canonical: (intent) => canonicals.has(intent.intentId),
    personas: (category, pooled) =>
      pooled.filter((p) => personas.get(category)?.has(p.text)).map((p) => p.text),
    paraphrases: (intent) =>
      planKept(intent.pool.filter((p) => paraphrases.get(intent.intentId)?.has(p.text))),
    humanReviewed: () => false,
  };
}

export type IntentRecord = {
  intentId: string;
  fit: IntentFit;
  paraphrases: number;
  canonicalReplaced: boolean;
  promoted: boolean;
  report: IntentPool["report"];
};

export function assemble(
  pools: readonly GroupPool[],
  judges: ReadonlyMap<string, Judge>,
): { catalog: SeedCatalogFile; report: Record<string, IntentRecord[]> } {
  const catalog: SeedCatalogFile = {
    categories: seedCategories().map((c) => ({
      key: c.key,
      labelKey: c.labelKey,
      placesTypes: c.placesTypes,
      synonyms: c.synonyms,
      archetype: c.archetype,
      defaultScope: c.defaultScope,
      register: c.register,
    })),
    intents: [],
    personas: [],
    paraphrases: [],
  };
  const report: Record<string, IntentRecord[]> = {};
  for (const pool of pools) {
    const group = groupKey(pool);
    const judge = judges.get(group);
    if (!judge) throw new Error(`${group} has no review`);
    const { language, registerProfile } = pool;
    const records: IntentRecord[] = [];
    for (const built of pool.categories) {
      const category = seedCategories().find((c) => c.key === built.key);
      if (!category) throw new Error(`${built.key} is not a seed category`);
      judge
        .personas(built.key, built.personas)
        .slice(0, PERSONAS_PER_CATEGORY)
        .forEach((preamble, n) => {
          catalog.personas.push({
            personaId: `${built.key}.${group}-persona_${n + 1}`,
            categoryKey: category.key,
            preamble,
            language,
            registerProfile,
          } satisfies SeedPersona);
        });
      const shaped = built.intents.map((intent) => {
        const approved = judge.paraphrases(intent);
        if (judge.canonical(intent)) {
          const canonical = { text: intent.canonical, generator: "template" as const };
          return {
            intent,
            kept: approved,
            canonical,
            canonicalReplaced: false,
            fit: intentFit(approved),
          };
        }
        // The closest approved open question stands in; with none the intent cannot ship.
        const open = approved.find((p) => p.format === "open_question");
        const kept = open ? approved.filter((p) => p !== open) : [];
        const canonical = {
          text: open?.text ?? intent.canonical,
          generator: open?.generator ?? "template",
        };
        return {
          intent,
          kept,
          canonical,
          canonicalReplaced: true,
          fit: open ? intentFit(kept) : ("drop" as const),
        };
      });
      // A dropped free-report intent gives its place to the next full one in slate order.
      const shipping = shaped.filter((s) => s.fit !== "drop");
      let free = shipping.filter((s) => s.intent.freeReport).length;
      const promoted = new Set<string>();
      for (const s of shipping) {
        if (free >= FREE_REPORT) break;
        if (!s.intent.freeReport && s.fit === "full") {
          promoted.add(s.intent.intentId);
          free++;
        }
      }
      for (const s of shaped) {
        const { intent, kept, canonical, canonicalReplaced, fit } = s;
        records.push({
          intentId: intent.intentId,
          fit,
          paraphrases: fit === "drop" ? 0 : kept.length + 1,
          canonicalReplaced,
          promoted: promoted.has(intent.intentId),
          report: intent.report,
        });
        if (fit === "drop") continue;
        const intentId = intent.intentId as SeedCatalogFile["intents"][number]["intentId"];
        catalog.intents.push({
          intentId,
          categoryKey: category.key,
          scope: category.defaultScope,
          kind: intent.kind,
          slug: intent.slug,
          labelKey: intent.labelKey,
          canonicalText: canonical.text,
          canonicalParaphraseId: `${intentId}.p00`,
          demandWeight: 1,
          freeReport: intent.freeReport || promoted.has(intent.intentId),
          language,
          registerProfile,
        });
        const texts: Array<Pick<Paraphrase, "text" | "format" | "generator">> = [
          { text: canonical.text, format: "open_question", generator: canonical.generator },
          ...kept.map(({ text, format, generator }) => ({ text, format, generator })),
        ];
        texts.forEach((p, n) => {
          catalog.paraphrases.push({
            paraphraseId: `${intentId}.p${String(n).padStart(2, "0")}`,
            intentId,
            ...p,
            humanReviewed: judge.humanReviewed(p.text),
          });
        });
      }
    }
    report[group] = records;
  }
  return { catalog, report };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function findFiles(dir: string, name: RegExp): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => name.test(f.split("/").pop() ?? ""))
    .map((f) => join(dir, f));
}

function main(): void {
  const [buildsDir, reviewsDir, decisionsFile, version] = process.argv.slice(2);
  if (!buildsDir || !reviewsDir || !decisionsFile || !version) {
    throw new Error("usage: assemble-seed <builds dir> <reviews dir> <decisions.json> <version>");
  }
  const pools = findFiles(buildsDir, /^seed-[a-z]{2}-[a-z]+\.json$/).map((f) =>
    readJson<GroupPool>(f),
  );
  const order = [
    "es-co",
    "es-neutral",
    "en-neutral",
    "pt-neutral",
    "fr-neutral",
    "de-neutral",
    "it-neutral",
  ];
  pools.sort((a, b) => order.indexOf(groupKey(a)) - order.indexOf(groupKey(b)));
  const spanish = pools.filter((p) => p.language === "es");
  const decided = readJson<Decision[]>(decisionsFile);
  const reasons = rejectionReasons(spanish, decided);
  for (const c of reasonClusters(reasons)) {
    console.log(`cluster: ${c.count} × ${c.reason} on ${c.kind}`);
  }
  const founder = founderJudge(spanish, decided);
  const judges = new Map<string, Judge>(spanish.map((p) => [groupKey(p), founder(groupKey(p))]));
  for (const file of findFiles(reviewsDir, /^review-[a-z]{2}-[a-z]+\.json$/)) {
    const review = readJson<{ group: string; categories: CategoryReview[] }>(file);
    judges.set(review.group, nativeJudge(review.categories));
  }
  const { catalog, report } = assemble(pools, judges);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = join(root, "data", version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(
    join(dir, "filter-report.json"),
    `${JSON.stringify({ ...report, rejections: reasons }, null, 2)}\n`,
  );
  for (const [group, records] of Object.entries(report)) {
    const count = (fit: IntentFit) => records.filter((r) => r.fit === fit).length;
    const promoted = records.filter((r) => r.promoted).map((r) => r.intentId);
    console.log(
      `${group}: full ${count("full")}, short ${count("short")}, drop ${count("drop")}; promoted ${promoted.join(", ") || "none"}`,
    );
  }
}

if (import.meta.main) main();
