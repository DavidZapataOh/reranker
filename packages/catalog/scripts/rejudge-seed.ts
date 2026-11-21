/**
 * Rules again on a built group's archived candidates with the current judge and ranks its pools
 * anew, without regenerating: the candidates stay identical and only embeddings and judge calls
 * are paid.
 *
 * Usage: pnpm --filter @reranker/catalog seed:rejudge <seed-<group>.json> <empty output dir>
 * Charged to the spend ledger as `benchmark`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { endPools } from "@reranker/db";
import { costOf as ledgerCost } from "@reranker/jobs";
import { seedCategories } from "../src/categories";
import { generatorConfigHash } from "../src/generate/config";
import { embed, generateParaphrases, judge } from "../src/generate/providers";
import {
  draftFor,
  type GroupPool,
  groupIntents,
  groupKey,
  guardContext,
  rejudgeIntent,
} from "./build-seed";
import { ProviderHealth } from "./provider-health";

async function main(): Promise<void> {
  const [rawPool, rawOut] = process.argv.slice(2);
  if (!rawPool || !rawOut) throw new Error("usage: rejudge-seed <seed-<group>.json> <empty dir>");
  const built = JSON.parse(readFileSync(resolve(rawPool), "utf8")) as GroupPool;
  const out = resolve(rawOut);
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length > 0) throw new Error(`${out} is not empty`);

  const spend = { purpose: "benchmark" as const, refType: "seed-rejudge", refId: randomUUID() };
  const deps = { generate: generateParaphrases, embed, judge, health: new ProviderHealth() };
  const categories = [];
  for (const pool of built.categories) {
    const category = seedCategories().find((c) => c.key === pool.key);
    if (!category) throw new Error(`${pool.key} is not a seed category`);
    const plans = new Map(groupIntents(category, built).map((p) => [p.intentId, p]));
    const intents = await Promise.all(
      pool.intents.map((intent) => {
        const plan = plans.get(intent.intentId);
        if (!plan) throw new Error(`${intent.intentId} is not in the group's plan`);
        const draft = draftFor(category, built, plan);
        return rejudgeIntent(intent, draft, guardContext(category, built, plan.kind), spend, deps);
      }),
    );
    for (const i of intents) console.log(`${i.intentId}: ${i.pool.length} pooled`);
    categories.push({ ...pool, intents });
  }
  const { amount_micros: costMicros } = await ledgerCost(spend.refType, spend.refId);
  const rejudged: GroupPool = {
    ...built,
    generatorConfigHash,
    builtAt: new Date().toISOString(),
    costMicros: built.costMicros + costMicros,
    categories,
  };
  const key = groupKey(built);
  writeFileSync(join(out, `seed-${key}.json`), `${JSON.stringify(rejudged, null, 2)}\n`);
  console.log(`${key}: US$${(costMicros / 1e6).toFixed(4)}`);
}

try {
  await main();
} finally {
  await endPools();
}
