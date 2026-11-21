// How often the guards alone would send a recorded language to the template fallback: an intent
// needs seven paraphrases past the guards to be complete, and a set five complete intents.
// Usage: pnpm --filter @reranker/catalog exec tsx scripts/guard-fallback.ts <generation-xx.json>
import { readFileSync } from "node:fs";
import type {
  IntentKind,
  MeasurementLanguage,
  ParaphraseFormat,
} from "@reranker/schema/measurement";
import { seedCategories } from "../src/categories.ts";
import { type GuardLanguage, type GuardName, guardParaphrase } from "../src/generate/guards.ts";

type Recorded = Array<{ text: string; format: ParaphraseFormat }> | { error: string };

export type Recording = {
  language: MeasurementLanguage;
  intents: Array<{
    categoryKey: string;
    noun: string | { text: string };
    synonyms: string[];
    kind: IntentKind;
    slug: string;
    canonical: string;
    openai: Recorded;
    gemini: Recorded;
  }>;
};

const MIN_PARAPHRASES = 7;
const MIN_INTENTS = 5;

function currentSynonyms(key: string, language: MeasurementLanguage): string[] | undefined {
  const category = seedCategories().find((c) => c.key === key);
  if (!category) return undefined;
  return language === "es" ? category.synonyms : category.languages[language].synonyms;
}

export function guardFallback(recording: Recording) {
  const rejected: Partial<Record<GuardName, number>> = {};
  let paraphrases = 0;
  const complete = new Map<string, number>();
  for (const intent of recording.intents) {
    const noun = typeof intent.noun === "string" ? intent.noun : intent.noun.text;
    const ctx = {
      scope: "local" as const,
      kind: intent.kind,
      language: recording.language as GuardLanguage,
      noun,
      // Today's synonyms, not those of the day it was recorded: the guards are what is measured.
      synonyms: currentSynonyms(intent.categoryKey, recording.language) ?? intent.synonyms,
      countryName: "",
      otherPlaceNames: new Set<string>(),
      blockedNames: new Set<string>(),
    };
    let passed = 0;
    for (const answer of [intent.openai, intent.gemini]) {
      if (!Array.isArray(answer)) continue;
      for (const p of answer) {
        paraphrases++;
        const verdict = guardParaphrase({ ...p, generator: "openai" }, ctx);
        if (verdict.ok) passed++;
        else rejected[verdict.guard] = (rejected[verdict.guard] ?? 0) + 1;
      }
    }
    const done = passed >= MIN_PARAPHRASES ? 1 : 0;
    complete.set(intent.categoryKey, (complete.get(intent.categoryKey) ?? 0) + done);
  }
  const categories = complete.size;
  const fallbacks = [...complete.values()].filter((n) => n < MIN_INTENTS).length;
  return { paraphrases, rejected, categories, fallbacks, fallbackRate: fallbacks / categories };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path] = process.argv.slice(2);
  if (!path) throw new Error("usage: guard-fallback.ts <generation-xx.json>");
  console.log(guardFallback(JSON.parse(readFileSync(path, "utf8")) as Recording));
}
