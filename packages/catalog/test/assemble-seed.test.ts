import { SeedCatalogFile } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import {
  assemble,
  type Decision,
  founderJudge,
  nativeJudge,
  reasonClusters,
  rejectionReasons,
} from "../scripts/assemble-seed";
import type { GroupPool } from "../scripts/build-seed";
import { fillCanonical } from "../scripts/build-seed";
import type { CategoryReview, Reviewed } from "../scripts/review-native";
import { type ReviewItem, reviewItems } from "../scripts/review-sample";
import { entry, FORMATS, groupPool } from "./fixtures/seed-pool";

const verdict = (keep: boolean) => ({ keep, reasons: [] });
const reviewed = (text: string, pass: boolean): Reviewed => ({
  text,
  verdicts: { openai: verdict(pass), gemini: verdict(pass) },
  pass,
});

function nativeReview(
  pool: GroupPool,
  fail: (text: string, intentId?: string) => boolean,
): CategoryReview[] {
  return pool.categories.map((c) => ({
    key: c.key,
    canonicals: c.intents.map((i) => ({
      ...reviewed(
        fillCanonical(i.canonical, c.noun, pool.language),
        !fail("canonical", i.intentId),
      ),
      intentId: i.intentId,
    })),
    personas: c.personas.map((p) => reviewed(p.text, !fail(p.text))),
    intents: c.intents.map((i) => ({
      intentId: i.intentId,
      paraphrases: i.pool.map((p) => reviewed(p.text, !fail(p.text, i.intentId))),
    })),
  }));
}

describe("native review", () => {
  // Balanced pools: every intent can ship in full.
  const base = groupPool("fr", "neutral");
  const fr: GroupPool = {
    ...base,
    categories: base.categories.map((c) => ({
      ...c,
      intents: c.intents.map((i) => ({
        ...i,
        pool: Array.from({ length: 48 }, (_, n) =>
          entry(`${i.intentId}:${n}`, FORMATS[n % 4] ?? "keyword"),
        ),
      })),
    })),
  };

  test("only items both reviewers passed ship, and the result is a valid seed", () => {
    const review = nativeReview(fr, (text) => text === "persona 0" || text.endsWith(":31"));
    const { catalog, report } = assemble([fr], new Map([["fr-neutral", nativeJudge(review)]]));
    expect(SeedCatalogFile.safeParse(catalog).success).toBe(true);
    expect(catalog.personas.map((p) => p.preamble).slice(0, 6)).toEqual([
      "persona 1",
      "persona 2",
      "persona 3",
      "persona 4",
      "persona 5",
      "persona 6",
    ]);
    expect(catalog.paraphrases.some((p) => p.text.endsWith(":31"))).toBe(false);
    expect(catalog.paraphrases.every((p) => !p.humanReviewed)).toBe(true);
    expect(report["fr-neutral"]?.every((r) => r.fit === "full")).toBe(true);
    expect(report["fr-neutral"]?.some((r) => r.promoted)).toBe(false);
  });

  test("a rejected canonical gives way to the closest approved open question", () => {
    const target = fr.categories[0]?.intents[0]?.intentId;
    const review = nativeReview(
      fr,
      (text, intentId) => text === "canonical" && intentId === target,
    );
    const { catalog, report } = assemble([fr], new Map([["fr-neutral", nativeJudge(review)]]));
    const intent = catalog.intents.find((i) => i.intentId === target);
    const first = fr.categories[0]?.intents[0]?.pool.find((p) => p.format === "open_question");
    expect(intent?.canonicalText).toBe(first?.text);
    expect(report["fr-neutral"]?.find((r) => r.intentId === target)?.canonicalReplaced).toBe(true);
  });

  test("a free-report intent below the floor leaves, and the next full intent in slate order takes its place", () => {
    const store = fr.categories.find((c) => c.key === "online_store");
    const urgency = store?.intents.find((i) => i.freeReport && i.kind === "urgency")?.intentId;
    // Every constraint of the store's urgency intent fails: fewer than two of a format drops it.
    const review = nativeReview(
      fr,
      (text, intentId) => intentId === urgency && Number(text.split(":").pop()) % 4 === 3,
    );
    const { catalog, report } = assemble([fr], new Map([["fr-neutral", nativeJudge(review)]]));
    const records = report["fr-neutral"] ?? [];
    expect(records.find((r) => r.intentId === urgency)?.fit).toBe("drop");
    const promoted = records.filter((r) => r.promoted).map((r) => r.intentId);
    expect(promoted).toEqual(["online_store.fr-neutral-ranking"]);
    const free = catalog.intents.filter((i) => i.categoryKey === "online_store" && i.freeReport);
    expect(free).toHaveLength(5);
    expect(catalog.intents.some((i) => i.intentId === urgency)).toBe(false);
  });
});

describe("the founder's decisions", () => {
  const pools = [groupPool("es", "co"), groupPool("es", "neutral")];
  const items = reviewItems(pools);
  const approveAll = (except: (i: ReviewItem) => boolean = () => false): Decision[] =>
    items.map((i) => ({
      item: i.id,
      step: 0,
      text: i.text,
      verdict: except(i) ? "reject" : "approve",
    }));

  test("every item needs a decision before anything is assembled", () =>
    expect(() => founderJudge(pools, approveAll().slice(1))).toThrow(/no decision/));

  test("a rejected persona or sample ships the reserve approved in its place", () => {
    const persona = items.find((i) => i.kind === "persona");
    const sample = items.find((i) => i.kind === "paraphrase");
    if (persona?.kind !== "persona" || sample?.kind !== "paraphrase") throw new Error("no items");
    const decisions = [
      ...approveAll((i) => i === persona || i === sample),
      { item: persona.id, step: 1, text: persona.reserves[0] ?? "", verdict: "approve" as const },
      { item: sample.id, step: 1, text: sample.reserves[0] ?? "", verdict: "approve" as const },
    ];
    const founder = founderJudge(pools, decisions);
    const judges = new Map(
      pools.map((p) => [`es-${p.registerProfile}`, founder(`es-${p.registerProfile}`)]),
    );
    const { catalog } = assemble(pools, judges);
    expect(SeedCatalogFile.safeParse(catalog).success).toBe(true);
    const preambles = catalog.personas.map((p) => p.preamble);
    expect(preambles).toContain(persona.reserves[0]);
    const texts = catalog.paraphrases
      .filter((p) => p.intentId === sample.intentId)
      .map((p) => p.text);
    expect(texts).toContain(sample.reserves[0]);
    expect(texts).not.toContain(sample.text);
    const reviewedSample = catalog.paraphrases.find((p) => p.text === sample.reserves[0]);
    expect(reviewedSample?.humanReviewed).toBe(true);
  });
});

describe("rejection reasons", () => {
  const pools = [groupPool("es", "co"), groupPool("es", "neutral")];
  const items = reviewItems(pools);
  const samples = items.filter((i) => i.kind === "paraphrase").slice(0, 4);
  const decided: Decision[] = [
    ...samples.map((i) => ({
      item: i.id,
      step: 0,
      text: i.text,
      verdict: "reject" as const,
      reason: "changes_question" as const,
    })),
    { item: items[0]?.id ?? "", step: 0, text: items[0]?.text ?? "", verdict: "reject" },
    {
      item: items[1]?.id ?? "",
      step: 0,
      text: items[1]?.text ?? "",
      verdict: "reject",
      reason: "other",
      note: "usa ustedeo",
    },
  ];

  test("rejections are counted by reason, per intent and per intent kind", () => {
    const report = rejectionReasons(pools, decided);
    expect(report.byReason).toEqual({ changes_question: 4, none: 1, other: 1 });
    expect(report.byKind.discovery).toEqual({ changes_question: 3 });
    expect(report.byKind.canonical).toEqual({ none: 1, other: 1 });
    expect(report.notes).toEqual([{ item: items[1]?.id, note: "usa ustedeo" }]);
  });

  test("a reason that dominates a kind is reported as a cluster", () =>
    expect(reasonClusters(rejectionReasons(pools, decided))).toEqual([
      { kind: "discovery", reason: "changes_question", count: 3 },
    ]));
});
