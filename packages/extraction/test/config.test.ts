import { describe, expect, test } from "vitest";
import {
  assertDistinctProviders,
  configHashOf,
  currentExtractorConfig,
  type ExtractorConfig,
  sha256Hex,
} from "../src/config";
import { PLATFORMS, type PlatformEntry, platformFor } from "../src/platforms";
import { estimateOf } from "../src/prices";
import { CLASSIFY_PROMPT_V1 } from "../src/prompts/classify.v1";
import { EXTRACT_EXAMPLES_V1, EXTRACT_PROMPT_V1 } from "../src/prompts/extract.v1";
import { JUDGE_PROMPT_V1 } from "../src/prompts/judge.v1";
import { RESOLVE_JUDGE_PROMPT_V1 } from "../src/prompts/resolve-judge.v1";
import { toExtractedMentions } from "../src/quote";
import { MentionsSchema } from "../src/schema";

const { configHash: _, ...cfg } = currentExtractorConfig;

describe("configHashOf", () => {
  test("hash is stable for the same config", () =>
    expect(configHashOf(cfg)).toBe(configHashOf(structuredClone(cfg))));

  test("is a hex sha256", () => expect(configHashOf(cfg)).toMatch(/^[0-9a-f]{64}$/));

  test("does not depend on key order", () => {
    const { version, models, ...rest } = structuredClone(cfg);
    expect(configHashOf({ ...rest, models, version })).toBe(configHashOf(cfg));
  });

  test("the current config carries its own hash", () => {
    expect(currentExtractorConfig.configHash).toBe(configHashOf(cfg));
    expect(configHashOf(currentExtractorConfig)).toBe(currentExtractorConfig.configHash);
  });

  test.each<[string, (c: ExtractorConfig) => void]>([
    [
      "prompt",
      (c) => {
        c.prompts.extract.sha256 = "x".repeat(64);
      },
    ],
    [
      "threshold",
      (c) => {
        c.resolution.margin = 0.07;
      },
    ],
    [
      "weight",
      (c) => {
        c.resolution.weights.name = 0.5;
      },
    ],
    [
      "timeout",
      (c) => {
        c.timeoutsMs.extract = 7000;
      },
    ],
    [
      "platform list",
      (c) => {
        (c.platforms as PlatformEntry[]).push({
          slug: "nueva",
          names: ["nueva"],
          domains: ["nueva.co"],
          kind: "platform",
        });
      },
    ],
    [
      "model",
      (c) => {
        c.models.primary.model = "gpt-6.1-terra";
      },
    ],
    [
      "reasoning effort",
      (c) => {
        c.models.secondary.reasoning = "low";
      },
    ],
    [
      "schema",
      (c) => {
        c.schemaSha256 = "0".repeat(64);
      },
    ],
    [
      "pin",
      (c) => {
        c.pinnedFrom = "bench-2026-12-01";
      },
    ],
  ])("changing the %s changes configHash", (_, mutate) => {
    const next = structuredClone(cfg);
    mutate(next);
    expect(configHashOf(next)).not.toBe(configHashOf(cfg));
  });
});

describe("assertDistinctProviders", () => {
  test("primary and secondary must come from different providers", () => {
    const same = structuredClone(cfg);
    same.models.secondary = { provider: "openai", model: "gpt-6.1-terra", reasoning: "low" };
    expect(() => assertDistinctProviders(same)).toThrow(/different providers/);
  });

  test("accepts the current pair", () => expect(() => assertDistinctProviders(cfg)).not.toThrow());
});

describe("currentExtractorConfig", () => {
  test("initial preview pair", () => {
    expect(currentExtractorConfig.models.primary).toEqual({
      provider: "openai",
      model: "gpt-6-luna",
      reasoning: "low",
    });
    expect(currentExtractorConfig.models.secondary).toEqual({
      provider: "gemini",
      model: "gemini-3.1-flash-lite",
      reasoning: "minimal",
    });
    expect(currentExtractorConfig.models.judge.model).toBe("gpt-6.1-terra");
    expect(currentExtractorConfig.models.resolveJudge.model).toBe("gpt-6-luna");
    expect(currentExtractorConfig.models.classifier.model).toBe("gpt-6-luna");
    expect(currentExtractorConfig.pinnedFrom).toBeNull();
  });

  test("thresholds and timeouts from the method", () => {
    expect(currentExtractorConfig).toMatchObject({
      merge: { nameJw: 0.92 },
      targetLikeJw: 0.8,
      liveResolutionTopN: 10,
      resolution: {
        weights: {
          name: 0.55,
          tokens: 0.15,
          type: 0.1,
          location: 0.1,
          operational: 0.1,
          domain: 0.15,
        },
        resolved: 0.9,
        margin: 0.08,
        floor: 0.6,
      },
      timeoutsMs: {
        extract: 6000,
        judge: 8000,
        classifier: 3000,
        findings: 3000,
        robots: 2000,
        website: 2000,
      },
    });
  });

  test("prompt hashes match the prompt files", () => {
    expect(currentExtractorConfig.prompts).toEqual({
      extract: { id: "extract.v1", sha256: sha256Hex(EXTRACT_PROMPT_V1) },
      judge: { id: "judge.v1", sha256: sha256Hex(JUDGE_PROMPT_V1) },
      resolveJudge: { id: "resolve-judge.v1", sha256: sha256Hex(RESOLVE_JUDGE_PROMPT_V1) },
      classify: { id: "classify.v1", sha256: sha256Hex(CLASSIFY_PROMPT_V1) },
    });
  });

  test("hashes the platform registry that tagging uses", () =>
    expect(currentExtractorConfig.platforms).toBe(PLATFORMS));

  test("is frozen", () => {
    expect(Object.isFrozen(currentExtractorConfig)).toBe(true);
    expect(Object.isFrozen(currentExtractorConfig.resolution.weights)).toBe(true);
    expect(Object.isFrozen(currentExtractorConfig.models.primary)).toBe(true);
  });

  test("every configured model has a token price", () => {
    for (const ref of Object.values(currentExtractorConfig.models)) {
      expect(estimateOf(ref.model, 1000, 100).amount_micros).toBeGreaterThan(0);
    }
  });
});

describe("prompts and registry", () => {
  test("the extraction prompt carries no capture text, so providers can cache it", () => {
    expect(EXTRACT_PROMPT_V1).not.toMatch(/\{\{|\$\{/);
  });

  test.each(EXTRACT_EXAMPLES_V1.map((e, i) => [i, e] as const))(
    "example %i matches the schema and every quote is in its answer",
    (_, example) => {
      expect(MentionsSchema.parse(example.output)).toEqual(example.output);
      expect(toExtractedMentions(example.answer, example.output).quoteMisses).toBe(0);
      expect(EXTRACT_PROMPT_V1).toContain(JSON.stringify(example.output));
    },
  );

  test("examples cover every stance, entity kind and answer kind", () => {
    const mentions = EXTRACT_EXAMPLES_V1.flatMap((e) => e.output.mentions);
    expect(new Set(mentions.map((m) => m.stance)).size).toBe(3);
    expect(new Set(mentions.map((m) => m.entityKind)).size).toBe(6);
    expect(new Set(EXTRACT_EXAMPLES_V1.map((e) => e.output.answerKind)).size).toBe(3);
  });

  test("tagging can follow a config's own registry", () => {
    const registry: PlatformEntry[] = [
      { slug: "nueva", names: ["Nueva"], domains: ["nueva.co"], kind: "platform" },
    ];
    expect(platformFor({ nameNorm: "nueva", citedUrls: [] }, registry)?.slug).toBe("nueva");
    expect(platformFor({ nameNorm: "booking", citedUrls: [] }, registry)).toBeNull();
  });
});
