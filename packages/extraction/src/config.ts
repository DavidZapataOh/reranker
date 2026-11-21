import { createHash } from "node:crypto";
import { AppError, z } from "@reranker/schema";
import canonicalize from "canonicalize";
import { NAME_RULES, type NameRules } from "./normalize";
import { PLATFORMS, type PlatformEntry } from "./platforms";
import { CLASSIFY_PROMPT_V1 } from "./prompts/classify.v1";
import { EXTRACT_PROMPT_V3 } from "./prompts/extract.v3";
import { JUDGE_PROMPT_V3 } from "./prompts/judge.v3";
import { RESOLVE_JUDGE_PROMPT_V2 } from "./prompts/resolve-judge.v2";
import type { ModelRef } from "./providers/types";
import { ClassifierSchema, MentionsSchema, ResolveJudgeSchema } from "./schema";

interface PromptRef<Id extends string> {
  id: Id;
  sha256: string;
}

/**
 * Everything that decides what an extraction says. Any change is a new config with a new hash;
 * rows are never reprocessed in place. Token prices stay out: a price change is not a method change.
 */
export interface ExtractorConfig {
  version: 1;
  models: {
    primary: ModelRef;
    secondary: ModelRef;
    judge: ModelRef;
    resolveJudge: ModelRef;
    classifier: ModelRef;
  };
  prompts: {
    extract: PromptRef<"extract.v3">;
    judge: PromptRef<"judge.v3">;
    resolveJudge: PromptRef<"resolve-judge.v2">;
    classify: PromptRef<"classify.v1">;
  };
  schemaSha256: string;
  names: NameRules;
  merge: { nameJw: number };
  targetLikeJw: number;
  liveResolutionTopN: number;
  resolution: {
    weights: {
      name: number;
      tokens: number;
      type: number;
      location: number;
      operational: number;
      domain: number;
    };
    resolved: number;
    margin: number;
    floor: number;
  };
  timeoutsMs: {
    extract: number;
    judge: number;
    classifier: number;
    findings: number;
    robots: number;
    website: number;
  };
  platforms: readonly PlatformEntry[];
  /** Benchmark run that chose these models; null while the preview pair runs. */
  pinnedFrom: string | null;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function jcs(value: unknown): string {
  const text = canonicalize(value);
  if (text === undefined) throw new AppError("internal", { detail: "Value has no JSON form" });
  return text;
}

/** Hex sha256 of the RFC 8785 serialization; a `configHash` already on the object is ignored. */
export function configHashOf(config: ExtractorConfig): string {
  const { configHash: _, ...rest } = config as ExtractorConfig & { configHash?: string };
  return sha256Hex(jcs(rest));
}

export function assertDistinctProviders(config: ExtractorConfig): void {
  const { primary, secondary } = config.models;
  if (primary.provider === secondary.provider) {
    throw new AppError("internal", {
      detail: `Primary and secondary extractors must come from different providers, both are ${primary.provider}`,
    });
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Every structured output the config runs; JudgeSchema is MentionsSchema.
const SCHEMA_SHA256 = sha256Hex(
  jcs({
    mentions: z.toJSONSchema(MentionsSchema),
    resolveJudge: z.toJSONSchema(ResolveJudgeSchema),
    classifier: z.toJSONSchema(ClassifierSchema),
  }),
);

function buildCurrent(): ExtractorConfig & { configHash: string } {
  const config: ExtractorConfig = {
    version: 1,
    models: {
      primary: { provider: "openai", model: "gpt-6-luna", reasoning: "none" },
      secondary: { provider: "gemini", model: "gemini-3.1-flash-lite", reasoning: "minimal" },
      judge: { provider: "openai", model: "gpt-6.1-terra", reasoning: "none" },
      resolveJudge: { provider: "openai", model: "gpt-6-luna", reasoning: "low" },
      classifier: { provider: "openai", model: "gpt-6-luna", reasoning: "low" },
    },
    prompts: {
      extract: { id: "extract.v3", sha256: sha256Hex(EXTRACT_PROMPT_V3) },
      judge: { id: "judge.v3", sha256: sha256Hex(JUDGE_PROMPT_V3) },
      resolveJudge: { id: "resolve-judge.v2", sha256: sha256Hex(RESOLVE_JUDGE_PROMPT_V2) },
      classify: { id: "classify.v1", sha256: sha256Hex(CLASSIFY_PROMPT_V1) },
    },
    schemaSha256: SCHEMA_SHA256,
    names: NAME_RULES,
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
      // Measured on real answers in six languages: the primary call ran p95 6.7 s, max 7.7 s.
      extract: 10_000,
      judge: 8000,
      classifier: 3000,
      findings: 3000,
      robots: 2000,
      website: 2000,
    },
    platforms: PLATFORMS,
    pinnedFrom: null,
  };
  assertDistinctProviders(config);
  return deepFreeze({ ...config, configHash: configHashOf(config) });
}

export const currentExtractorConfig: Readonly<ExtractorConfig & { configHash: string }> =
  buildCurrent();
