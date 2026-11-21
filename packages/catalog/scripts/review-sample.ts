/**
 * Lays out the Spanish groups for a person to review: every canonical once (both profiles share
 * most), the six personas each category ships with, and a fixed sample of three of the 29
 * paraphrases each intent ships with. Reserves come along only to stand in, in order, for what
 * the reviewer rejects.
 *
 * Usage: pnpm --filter @reranker/catalog seed:review <seed-es-co.json> <seed-es-neutral.json> <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_LOCALE, getTranslator } from "@reranker/i18n";
import { seedCategories } from "../src/categories";
import { fillCanonical, type GroupPool, groupKey, type PoolEntry } from "./build-seed";
import { PERSONAS_PER_CATEGORY, planKept, replacementFor, sampleOf } from "./seed-pool";

const REPLACEMENTS = 3;

const labels = getTranslator(DEFAULT_LOCALE, "catalog.categories");

export type ReviewItem =
  | { id: string; kind: "canonical"; category: string; text: string; intentIds: string[] }
  | {
      id: string;
      kind: "persona";
      group: string;
      category: string;
      text: string;
      reserves: string[];
    }
  | {
      id: string;
      kind: "paraphrase";
      group: string;
      category: string;
      intentId: string;
      canonical: string;
      text: string;
      reserves: string[];
    };

export function reviewItems(pools: readonly GroupPool[]): ReviewItem[] {
  const canonicals = new Map<string, Extract<ReviewItem, { kind: "canonical" }>>();
  const personas: ReviewItem[] = [];
  const paraphrases: ReviewItem[] = [];
  for (const category of seedCategories()) {
    const label = labels(category.key);
    for (const pool of pools) {
      const group = groupKey(pool);
      const built = pool.categories.find((c) => c.key === category.key);
      if (!built) throw new Error(`${group} has no ${category.key}`);
      for (const intent of built.intents) {
        const canonical = fillCanonical(intent.canonical, built.noun, pool.language);
        const shared = canonicals.get(`${category.key}|${canonical}`);
        if (shared) shared.intentIds.push(intent.intentId);
        else
          canonicals.set(`${category.key}|${canonical}`, {
            id: `canonical:${intent.intentId}`,
            kind: "canonical",
            category: label,
            text: canonical,
            intentIds: [intent.intentId],
          });
        const kept = planKept(intent.pool);
        const taken = new Set<PoolEntry>(kept);
        for (const [n, entry] of sampleOf(intent.intentId, kept).entries()) {
          const reserves: string[] = [];
          for (let r = 0; r < REPLACEMENTS; r++) {
            const next = replacementFor(intent.pool, taken, entry.format);
            if (!next) break;
            taken.add(next);
            reserves.push(next.text);
          }
          paraphrases.push({
            id: `paraphrase:${intent.intentId}:${n}`,
            kind: "paraphrase",
            group,
            category: label,
            intentId: intent.intentId,
            canonical,
            text: entry.text,
            reserves,
          });
        }
      }
      const reserves = built.personas.slice(PERSONAS_PER_CATEGORY).map((p) => p.text);
      for (const [n, persona] of built.personas.slice(0, PERSONAS_PER_CATEGORY).entries()) {
        personas.push({
          id: `persona:${group}:${category.key}:${n}`,
          kind: "persona",
          group,
          category: label,
          text: persona.text,
          reserves,
        });
      }
    }
  }
  return [...canonicals.values(), ...personas, ...paraphrases];
}

function main(): void {
  const [co, neutral, out] = process.argv.slice(2);
  if (!co || !neutral || !out) throw new Error("usage: review-sample <es-co> <es-neutral> <out>");
  const pools = [co, neutral].map((f) => JSON.parse(readFileSync(resolve(f), "utf8")) as GroupPool);
  const items = reviewItems(pools);
  writeFileSync(
    resolve(out),
    `${JSON.stringify({ version: pools[0]?.version, items }, null, 2)}\n`,
  );
  const count = (kind: ReviewItem["kind"]) => items.filter((i) => i.kind === kind).length;
  console.log(
    `${items.length} items: ${count("canonical")} canonicals, ${count("persona")} personas, ${count("paraphrase")} paraphrases`,
  );
}

if (import.meta.main) main();
