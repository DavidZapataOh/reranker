/**
 * Records what both generation providers write for every local seed category in one language,
 * before any guard, so guard changes can be measured against real model output.
 *
 * Usage: pnpm --filter @reranker/catalog record:generation <language> <empty output dir>
 * Each seed category asks its archetype's six intents of both providers (12 calls a category),
 * charged to the spend ledger as `contract-test`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { endPools } from "@reranker/db";
import { MeasurementLanguage } from "@reranker/schema/measurement";
import { seedCategories } from "../src/categories";
import { generatorConfigHash } from "../src/generate/config";
import { isGenerationLanguage } from "../src/generate/prompts";
import { type DraftIntent, generateParaphrases } from "../src/generate/providers";
import { agree, nounText } from "../src/grammar";
import { fallbackTemplates } from "../src/templates";

const PROVIDERS = ["openai", "gemini"] as const;
const CALL_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const [rawLanguage, rawOut] = process.argv.slice(2);
  const language = MeasurementLanguage.parse(rawLanguage);
  if (!isGenerationLanguage(language)) throw new Error(`${language} has no generation prompts`);
  if (!rawOut) throw new Error("usage: record-generation <language> <empty output dir>");
  const out = resolve(rawOut);
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length > 0) throw new Error(`${out} is not empty`);

  const spend = {
    purpose: "contract-test" as const,
    refType: "generation-record",
    refId: randomUUID(),
  };
  const intents = [];
  for (const category of seedCategories()) {
    const names =
      language === "es"
        ? { noun: category.noun, synonyms: category.synonyms }
        : category.languages[language];
    // A web-only store names what it sells, so it has no noun of its own to ask with.
    if (category.defaultScope !== "local" || names.noun === null) continue;
    const noun = names.noun;
    const text = nounText(noun);
    const business = {
      key: category.key,
      source: "seed" as const,
      label: text,
      noun: text,
      archetype: category.archetype,
      scope: "local" as const,
      register: category.register,
      placesTypes: category.placesTypes,
    };
    for (const template of fallbackTemplates(category.archetype, "local", language)) {
      const intent = {
        category: business,
        noun,
        scope: "local",
        kind: template.kind,
        slug: template.slug,
        canonicalText: agree(template.canonical, noun, language).replaceAll("{sustantivo}", text),
        language,
        registerProfile: "neutral",
      } as DraftIntent;
      const answers = await Promise.allSettled(
        PROVIDERS.map((provider) => {
          const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
          return generateParaphrases(
            provider,
            { intent, register: "neutral", withPersonas: false },
            { spend, signal, deadlineAt: Date.now() + CALL_TIMEOUT_MS },
          );
        }),
      );
      intents.push({
        categoryKey: category.key,
        noun,
        synonyms: names.synonyms,
        kind: template.kind,
        slug: template.slug,
        canonical: intent.canonicalText,
        ...Object.fromEntries(
          PROVIDERS.map((provider, i) => {
            const answer = answers[i];
            return [
              provider,
              answer?.status === "fulfilled"
                ? answer.value.paraphrases
                : { error: String((answer?.reason as Error | undefined)?.name ?? "error") },
            ];
          }),
        ),
      });
      console.log(`${category.key}.${template.slug}: recorded`);
    }
  }
  writeFileSync(
    join(out, `generation-${language}.json`),
    `${JSON.stringify({ language, recordedAt: new Date().toISOString(), generatorConfigHash, intents }, null, 2)}\n`,
  );
}

try {
  await main();
} finally {
  await endPools();
}
