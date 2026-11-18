import { ProviderUnavailableError } from "@reranker/jobs";
import type { ExtractedMention, Stance } from "@reranker/schema/measurement";
import { describe, expect, test, vi } from "vitest";
import { currentExtractorConfig } from "../src/config";
import { type DisputeSet, type MergeInput, mergeExtractions, pairMentions } from "../src/merge";
import { normalizeName } from "../src/normalize";
import { locateQuote } from "../src/quote";
import type { MentionsOutput } from "../src/schema";

const markdown =
  "Te recomiendo Clínica A en Laureles. También está Clínica B. Clínica C es buena. Clínica D atiende rápido.";

const at = (
  name: string,
  stance: Stance,
  over: Partial<ExtractedMention> = {},
): ExtractedMention => {
  const span = locateQuote(markdown, name);
  if (!span) throw new Error(`${name} is not in the fixture answer`);
  return {
    name,
    nameNorm: normalizeName(name, "business"),
    quote: markdown.slice(span.start, span.end),
    startOffset: span.start,
    endOffset: span.end,
    ordinal: null,
    stance,
    entityKind: "business",
    sentiment: "positive",
    locationHint: null,
    citedUrls: [],
    ...over,
  };
};

const A_rec = at("Clínica A", "recommendation", { ordinal: 1 });
const A_rec2 = at("Clinica A", "recommendation", { name: "Clinica A", ordinal: 1 });
const A_inc = at("Clínica A", "incidental");
const B_rec = at("Clínica B", "recommendation", { ordinal: 2 });
const B_inc = at("Clínica B", "incidental");
const B_inc2 = at("Clínica B", "incidental", { sentiment: "neutral" });
const C_rec = at("Clínica C", "recommendation");
const D_rec = at("Clínica D", "recommendation");

const out = (mentions: ExtractedMention[]): MentionsOutput => ({
  answerKind: "names_entities",
  mentions: mentions.map((m) => ({
    name: m.name,
    quote: m.quote,
    stance: m.stance,
    entityKind: m.entityKind,
    sentiment: m.sentiment,
    locationHint: m.locationHint,
    citedUrls: m.citedUrls,
  })),
});

const base: MergeInput = {
  markdown,
  primary: [],
  secondary: [],
  recallHints: [],
  config: currentExtractorConfig,
  judge: async () => out([]),
};

const cruzVerde = (start: number, end: number): ExtractedMention => ({
  name: "Cruz Verde",
  nameNorm: "cruz verde",
  quote: "Cruz Verde",
  startOffset: start,
  endOffset: end,
  ordinal: null,
  stance: "recommendation",
  entityKind: "chain",
  sentiment: "positive",
  locationHint: null,
  citedUrls: [],
});

describe("pairMentions", () => {
  test("the same entity twice in one answer pairs by offset overlap", () => {
    const s = pairMentions([cruzVerde(0, 10), cruzVerde(40, 50)], [cruzVerde(0, 10)], 0.92);
    expect(s.agreed).toHaveLength(1);
    expect(s.onlyPrimary).toHaveLength(1);
    expect(s.onlySecondary).toHaveLength(0);
    expect(s.stanceConflicts).toHaveLength(0);
  });

  test("a repeated quote shares its first offsets and still pairs one to one", () => {
    const s = pairMentions([cruzVerde(0, 10), cruzVerde(0, 10)], [cruzVerde(0, 10)], 0.92);
    expect(s.agreed).toHaveLength(1);
    expect(s.onlyPrimary).toHaveLength(1);
  });

  test("overlapping spans with unrelated names do not pair", () => {
    const other = { ...cruzVerde(0, 10), name: "Farmatodo", nameNorm: "farmatodo" };
    const s = pairMentions([cruzVerde(0, 10)], [other], 0.92);
    expect(s.onlyPrimary).toHaveLength(1);
    expect(s.onlySecondary).toEqual([other]);
  });

  test("the same name in spans that do not overlap does not pair", () => {
    const s = pairMentions([cruzVerde(0, 10)], [cruzVerde(10, 20)], 0.92);
    expect(s.agreed).toHaveLength(0);
    expect(s.onlyPrimary).toHaveLength(1);
    expect(s.onlySecondary).toHaveLength(1);
  });

  test("token containment pairs a shorter name with its longer form", () => {
    const long = {
      ...cruzVerde(0, 18),
      name: "Droguería Cruz Verde",
      nameNorm: "drogueria cruz verde",
    };
    const s = pairMentions([long], [cruzVerde(10, 18)], 0.92);
    expect(s.agreed).toEqual([long]);
  });

  test("a different stance on the same entity is a stance conflict, preferring a same-stance partner", () => {
    const incidental = { ...cruzVerde(0, 10), stance: "incidental" as const };
    const s = pairMentions([cruzVerde(0, 10)], [incidental, cruzVerde(0, 10)], 0.92);
    expect(s.agreed).toHaveLength(1);
    expect(s.onlySecondary).toEqual([incidental]);

    const conflict = pairMentions([A_rec], [A_inc], 0.92);
    expect(conflict.stanceConflicts).toEqual([[A_rec, A_inc]]);
    expect(conflict.agreed).toHaveLength(0);
  });
});

describe("mergeExtractions", () => {
  test("full agreement never calls the judge", async () => {
    const judge = vi.fn();
    const r = await mergeExtractions({
      ...base,
      primary: [A_rec, B_inc],
      secondary: [A_rec2, B_inc2],
      judge,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(r).toEqual({
      mentions: [A_rec, B_inc],
      agreement: "agreed",
      judgeUsed: false,
      disputedCount: 0,
      judgeOutput: null,
    });
  });

  test("any disagreement calls the judge exactly once per response", async () => {
    const verdict = out([A_rec, C_rec]);
    const judge = vi.fn(async (_: DisputeSet) => verdict);
    const r = await mergeExtractions({
      ...base,
      primary: [A_rec, B_rec],
      secondary: [A_inc, C_rec],
      judge,
    });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0]?.[0]).toEqual({
      agreed: [],
      onlyPrimary: [B_rec],
      onlySecondary: [C_rec],
      stanceConflicts: [[A_rec, A_inc]],
      recallHints: [],
    });
    expect(r).toMatchObject({
      agreement: "adjudicated",
      judgeUsed: true,
      disputedCount: 3,
      judgeOutput: verdict,
    });
    expect(r.mentions.map((m) => [m.name, m.ordinal])).toEqual([
      ["Clínica A", 1],
      ["Clínica C", 2],
    ]);
  });

  test("the final list is agreed plus the verdict, in answer order, without offset duplicates", async () => {
    const r = await mergeExtractions({
      ...base,
      primary: [B_rec, D_rec],
      secondary: [B_rec, C_rec],
      judge: async () => out([A_rec, B_rec, D_rec, D_rec]),
    });
    expect(r.mentions.map((m) => [m.name, m.ordinal])).toEqual([
      ["Clínica A", 1],
      ["Clínica B", 2],
      ["Clínica D", 3],
    ]);
  });

  test("recall hints alone force the judge", async () => {
    const judge = vi.fn(async (_: DisputeSet) => out([A_rec, D_rec]));
    const r = await mergeExtractions({
      ...base,
      primary: [A_rec],
      secondary: [A_rec2],
      recallHints: ["Clínica D"],
      judge,
    });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0]?.[0].recallHints).toEqual(["Clínica D"]);
    expect(r).toMatchObject({ agreement: "adjudicated", disputedCount: 1 });
    expect(r.mentions.map((m) => m.name)).toEqual(["Clínica A", "Clínica D"]);
  });

  test("judge failure keeps the primary list and reports single", async () => {
    const r = await mergeExtractions({
      ...base,
      primary: [A_rec],
      secondary: [B_rec],
      judge: async () => {
        throw new ProviderUnavailableError("openai", 1000);
      },
    });
    expect(r).toMatchObject({ agreement: "single", judgeUsed: false, judgeOutput: null });
    expect(r.mentions).toEqual([A_rec]);
  });

  test("judge quotes are validated like any extractor output", async () => {
    const verdict = out([C_rec]);
    verdict.mentions.push({
      ...(out([D_rec]).mentions[0] as MentionsOutput["mentions"][number]),
      quote: "Clínica Inventada",
    });
    const r = await mergeExtractions({
      ...base,
      primary: [C_rec],
      secondary: [D_rec],
      judge: async () => verdict,
    });
    expect(r.mentions.map((m) => m.name)).toEqual(["Clínica C"]);
  });

  test("secondary null is single mode without a judge", async () => {
    const judge = vi.fn();
    const r = await mergeExtractions({
      ...base,
      primary: [B_rec, A_rec],
      secondary: null,
      recallHints: ["Clínica D"],
      judge,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(r).toEqual({
      mentions: [A_rec, B_rec],
      agreement: "single",
      judgeUsed: false,
      disputedCount: 0,
      judgeOutput: null,
    });
  });

  test("inputs are not mutated when ordinals are recounted", async () => {
    const primary = [{ ...C_rec, ordinal: 7 }];
    await mergeExtractions({ ...base, primary, secondary: null });
    expect(primary[0]?.ordinal).toBe(7);
  });
});
