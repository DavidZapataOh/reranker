/**
 * Reviews a built seed group in a language no person on the team reads: two reviewers on
 * different providers, each in a call of its own, judge every canonical, every persona and every
 * pooled paraphrase against the same rubric. An item passes only when both keep it; every verdict
 * is recorded, and freezing ships only passing items.
 *
 * Usage: pnpm --filter @reranker/catalog seed:review-native <seed-<group>.json> <empty output dir>
 * Charged to the spend ledger as `benchmark`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { endPools } from "@reranker/db";
import { costOf as ledgerCost, type SpendContext } from "@reranker/jobs";
import type { IntentKind } from "@reranker/schema/measurement";
import { isGenerationLanguage } from "../src/generate/prompts";
import { type ReviewRequest, type ReviewVerdict, reviewNative } from "../src/generate/providers";
import type { CallContext } from "../src/generate/spend";
import { nounText } from "../src/grammar";
import { type CategoryPool, fillCanonical, type GroupPool, groupKey } from "./build-seed";
import { failureReason, ProviderHealth } from "./provider-health";

const REVIEWERS = ["openai", "gemini"] as const;
const CALL_MS = 120_000;

type Reviewer = (typeof REVIEWERS)[number];
export type Reviewed = { text: string; verdicts: Record<Reviewer, ReviewVerdict>; pass: boolean };

export type CategoryReview = {
  key: string;
  canonicals: Array<Reviewed & { intentId: string }>;
  personas: Reviewed[];
  intents: Array<{ intentId: string; paraphrases: Reviewed[] }>;
};

type Review = (
  provider: Reviewer,
  req: ReviewRequest,
  ctx: CallContext,
) => Promise<ReviewVerdict[]>;

const callContext = (spend: SpendContext): CallContext => ({
  spend,
  signal: AbortSignal.timeout(CALL_MS),
  deadlineAt: Date.now() + CALL_MS,
});

/** Why each reviewer's calls failed, counted, so a reviewer that never ruled is seen at once. */
export type Failures = Record<Reviewer, Record<string, number>>;

/** Both reviewers on the same items; a reviewer that failed counts as no verdict for each. */
async function bothReview(
  req: ReviewRequest,
  spend: SpendContext,
  review: Review,
  failures: Failures,
  health?: ProviderHealth,
): Promise<Reviewed[]> {
  const answers = await Promise.allSettled(
    REVIEWERS.map((provider) => review(provider, req, callContext(spend))),
  );
  answers.forEach((answer, p) => {
    const provider = REVIEWERS[p] as Reviewer;
    if (answer.status !== "rejected") {
      health?.record(provider, { ok: true });
      return;
    }
    const reason = failureReason(answer.reason);
    failures[provider][reason] = (failures[provider][reason] ?? 0) + 1;
    health?.record(provider, { ok: false, reason });
  });
  return req.items.map((item, i) => {
    const verdicts = Object.fromEntries(
      REVIEWERS.map((provider, p) => {
        const answer = answers[p];
        return [provider, answer?.status === "fulfilled" ? (answer.value[i] ?? null) : null];
      }),
    ) as Record<Reviewer, ReviewVerdict>;
    const pass = REVIEWERS.every((r) => verdicts[r]?.keep === true);
    return { text: item.text, verdicts, pass };
  });
}

export async function reviewCategory(
  group: Pick<GroupPool, "language" | "registerProfile">,
  category: CategoryPool,
  spend: SpendContext,
  review: Review = reviewNative,
  failures: Failures = { openai: {}, gemini: {} },
  health?: ProviderHealth,
): Promise<CategoryReview> {
  const { language, registerProfile } = group;
  if (!isGenerationLanguage(language)) throw new Error(`${language} has no prompts`);
  const noun = nounText(category.noun);
  const base = { language, registerProfile, category: category.key, noun };
  const canonicals = category.intents.map((intent) => ({
    intentId: intent.intentId,
    kind: intent.kind as IntentKind,
    text: fillCanonical(intent.canonical, category.noun, language),
  }));
  const [head, ...paraphrases] = await Promise.all([
    bothReview(
      {
        ...base,
        items: [
          ...canonicals.map((c) => ({ role: "canonical" as const, text: c.text })),
          ...category.personas.map((p) => ({ role: "persona" as const, text: p.text })),
        ],
      },
      spend,
      review,
      failures,
      health,
    ),
    ...category.intents.map((intent, i) =>
      bothReview(
        {
          ...base,
          intent: { kind: intent.kind, canonical: canonicals[i]?.text ?? intent.canonical },
          items: intent.pool.map((p) => ({ role: "paraphrase" as const, text: p.text })),
        },
        spend,
        review,
        failures,
        health,
      ),
    ),
  ]);
  const reviewed = head ?? [];
  return {
    key: category.key,
    canonicals: canonicals.map((c, i) => ({ ...(reviewed[i] as Reviewed), intentId: c.intentId })),
    personas: reviewed.slice(canonicals.length),
    intents: category.intents.map((intent, i) => ({
      intentId: intent.intentId,
      paraphrases: paraphrases[i] ?? [],
    })),
  };
}

async function main(): Promise<void> {
  const [rawPool, rawOut] = process.argv.slice(2);
  if (!rawPool || !rawOut) throw new Error("usage: review-native <seed-<group>.json> <empty dir>");
  const pool = JSON.parse(readFileSync(resolve(rawPool), "utf8")) as GroupPool;
  if (pool.language === "es") throw new Error("Spanish is reviewed by a person, not here");
  const out = resolve(rawOut);
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length > 0) throw new Error(`${out} is not empty`);

  const spend = { purpose: "benchmark" as const, refType: "seed-review", refId: randomUUID() };
  const categories: CategoryReview[] = [];
  const failures: Failures = { openai: {}, gemini: {} };
  const health = new ProviderHealth();
  for (const category of pool.categories) {
    const reviewed = await reviewCategory(pool, category, spend, reviewNative, failures, health);
    categories.push(reviewed);
    const passed = (items: Reviewed[]) => `${items.filter((r) => r.pass).length}/${items.length}`;
    console.log(
      `${category.key}: canonicals ${passed(reviewed.canonicals)}, personas ${passed(reviewed.personas)}, paraphrases ${passed(reviewed.intents.flatMap((i) => i.paraphrases))}`,
    );
  }
  const { amount_micros: costMicros } = await ledgerCost(spend.refType, spend.refId);
  const key = groupKey(pool);
  const file = {
    group: key,
    reviewedAt: new Date().toISOString(),
    costMicros,
    failures,
    categories,
  };
  for (const [provider, reasons] of Object.entries(failures)) {
    for (const [reason, n] of Object.entries(reasons))
      console.log(`${provider} failed ${n}×: ${reason}`);
  }
  writeFileSync(join(out, `review-${key}.json`), `${JSON.stringify(file, null, 2)}\n`);
  console.log(`${key}: US$${(costMicros / 1e6).toFixed(4)}`);
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await endPools();
  }
}
