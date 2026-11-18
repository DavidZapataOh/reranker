import type { EngineAnswer } from "@reranker/capture";
import { getArtifact, putArtifact } from "@reranker/evidence";
import { isEnabled } from "@reranker/flags";
import { ProviderUnavailableError, RateLimitedError, type SpendContext } from "@reranker/jobs";
import {
  AppError,
  type CaptureChannel,
  cost,
  type EngineId,
  type ProviderCost,
  sumCosts,
} from "@reranker/schema";
import type {
  Agreement,
  AnswerKind,
  ExtractedMention,
  ResolvedMention,
  ResponseExtraction,
} from "@reranker/schema/measurement";
import { configHashOf, currentExtractorConfig, type ExtractorConfig, jcs } from "./config";
import { type DisputeSet, mergeExtractions } from "./merge";
import { jaroWinkler, nameHmac, normalizeName, tokenContainment } from "./normalize";
import { platformFor, tagPlatforms } from "./platforms";
import { costOfUsage } from "./prices";
import { EXTRACT_PROMPT_V1 } from "./prompts/extract.v1";
import { JUDGE_PROMPT_V1 } from "./prompts/judge.v1";
import { callerFor, type PaidResult, paidCall } from "./providers/call";
import { type ModelRef, ProviderIncompleteError, ProviderRefusalError } from "./providers/types";
import { locateQuote, toExtractedMentions } from "./quote";
import { JudgeSchema, type MentionsOutput, MentionsSchema } from "./schema";
import { findExtraction, insertExtraction } from "./store";

export interface RawCapture {
  capture: {
    id: string;
    engine: EngineId;
    channel: CaptureChannel;
    status: "succeeded" | "provider_error" | "timeout";
    modelReported: string | null;
    slotId: string;
  };
  answer: EngineAnswer | null;
}

const MAX_OUTPUT_TOKENS = 4096;
const ARTIFACT_KIND = "extractions";

/** What a call that ran left behind: its raw output, or the refusal that replaced it. */
type CallRecord = { model: string; output: MentionsOutput | null; refused: boolean };

/** Everything needed to audit the extraction and to return it again without paying twice. */
interface ExtractionOutputs {
  captureId: string;
  configHash: string;
  primary: CallRecord;
  secondary: CallRecord | null;
  judge: CallRecord | null;
  quoteMisses: { primary: number; secondary: number; judge: number };
  answerKind: AnswerKind;
  agreement: Agreement;
  disputedCount: number;
  mentions: ExtractedMention[];
  cost: ProviderCost;
  latencyMs: number;
}

const configHashes = new WeakMap<ExtractorConfig, string>();

function hashOf(config: ExtractorConfig): string {
  let hash = configHashes.get(config);
  if (hash === undefined) {
    hash = configHashOf(config);
    configHashes.set(config, hash);
  }
  return hash;
}

// The secondary only adds a second opinion: when it is down, slow or unusable the answer is
// extracted in single mode, which the result records. Anything else is a bug or a cap and stops.
const SECONDARY_FALLBACK = [
  ProviderUnavailableError,
  RateLimitedError,
  ProviderRefusalError,
  ProviderIncompleteError,
];

/** The provisional key and resolution until the report resolves its mentions. */
function unresolved(mention: ExtractedMention, config: ExtractorConfig): ResolvedMention {
  const platform =
    mention.entityKind === "platform" || mention.entityKind === "directory_or_media"
      ? platformFor(mention, config.platforms)
      : null;
  // A professional's name never leaves this package in clear.
  const name =
    mention.entityKind === "professional" ? nameHmac(mention.nameNorm) : mention.nameNorm;
  return {
    ...mention,
    entityKey: platform ? `platform:${platform.slug}` : `name:${name}`,
    placeId: null,
    resolution: { status: platform ? "platform" : "not_attempted", method: "none", score: null },
    isTarget: false,
  };
}

function toResult(outputs: ExtractionOutputs, config: ExtractorConfig): ResponseExtraction {
  return {
    captureId: outputs.captureId,
    configHash: outputs.configHash,
    answerKind: outputs.answerKind,
    agreement: outputs.agreement,
    mentions: outputs.mentions.map((m) => unresolved(m, config)),
    models: {
      primary: outputs.primary.model,
      secondary: outputs.secondary?.model ?? null,
      judge: outputs.judge?.model ?? null,
    },
    cost: outputs.cost,
    latencyMs: outputs.latencyMs,
  };
}

async function storedOutputs(sha256: string): Promise<ExtractionOutputs> {
  const bytes = await getArtifact(ARTIFACT_KIND, sha256);
  if (!bytes) {
    throw new AppError("internal", { detail: `extraction outputs ${sha256} are missing` });
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as ExtractionOutputs;
}

/** Names the engine itself listed that the answer contains and neither extractor found. */
function recallHintsOf(answer: EngineAnswer, found: ExtractedMention[], nameJw: number): string[] {
  const names = [
    ...(answer.brandEntities ?? []).map((e) => e.name),
    ...(answer.localBusinesses ?? []).map((b) => b.name),
  ];
  const hints: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const norm = normalizeName(name, "business");
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (!locateQuote(answer.markdown, name)) continue;
    const known = found.some(
      (m) => jaroWinkler(norm, m.nameNorm) >= nameJw || tokenContainment(norm, m.nameNorm),
    );
    if (!known) hints.push(name);
  }
  return hints;
}

// paidCall settled a refusal from its usage; one without usage settled the reservation, which
// only the spend ledger records.
function refusalCost(model: ModelRef, refusal: ProviderRefusalError | null): ProviderCost {
  return refusal?.usage ? costOfUsage(model.model, refusal.usage) : cost(0, "USD");
}

function judgeMessage(markdown: string, disputed: DisputeSet): string {
  return `Respuesta:\n"""\n${markdown}\n"""\n\nDesacuerdo:\n${JSON.stringify(disputed)}`;
}

function shortCircuit(
  capture: RawCapture["capture"],
  answerKind: "capture_failed" | "no_entities",
  config: ExtractorConfig,
): ResponseExtraction {
  return {
    captureId: capture.id,
    configHash: hashOf(config),
    answerKind,
    agreement: "single",
    mentions: [],
    models: { primary: config.models.primary.model, secondary: null, judge: null },
    cost: cost(0, "USD"),
    latencyMs: 0,
  };
}

/**
 * Turns one captured answer into its mentions: both extractors in parallel, the judge only on
 * disagreement, the raw outputs to R2 and one row per capture and config. A retried step reads
 * the stored extraction back instead of paying for it again.
 */
export async function extractResponse(
  raw: RawCapture,
  ctx: { spend: SpendContext },
  opts: { config?: ExtractorConfig } = {},
): Promise<ResponseExtraction> {
  const config = opts.config ?? currentExtractorConfig;
  const { capture, answer } = raw;
  if (capture.status !== "succeeded") return shortCircuit(capture, "capture_failed", config);
  if (!answer) {
    throw new AppError("internal", { detail: `capture ${capture.id} succeeded without an answer` });
  }
  if (!answer.present || answer.markdown.trim() === "") {
    return shortCircuit(capture, "no_entities", config);
  }

  const configHash = hashOf(config);
  const existing = await findExtraction(capture.id, configHash);
  if (existing) return toResult(await storedOutputs(existing.outputsSha256), config);

  const startedAt = Date.now();
  const { markdown } = answer;
  const spend = ctx.spend;
  const extract = (model: ModelRef, retries: 0 | 1) =>
    paidCall(
      callerFor(model),
      {
        model,
        system: EXTRACT_PROMPT_V1,
        user: markdown,
        schema: MentionsSchema,
        schemaName: "mentions",
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
      { timeoutMs: config.timeoutsMs.extract, retries, spend },
    );

  // The secondary gets no retry: a second attempt would outlast the primary's budget, and
  // single mode is the documented answer to a missing second opinion. Both settle before any
  // error is thrown, so no call is left running unsettled.
  const [primarySettled, secondarySettled] = await Promise.allSettled([
    extract(config.models.primary, 1),
    isEnabled("extraction-secondary", { kind: "system" }).then((on) =>
      on ? extract(config.models.secondary, 0) : null,
    ),
  ]);

  let primaryResult: PaidResult<MentionsOutput> | null = null;
  let refusal: ProviderRefusalError | null = null;
  if (primarySettled.status === "fulfilled") primaryResult = primarySettled.value;
  else if (primarySettled.reason instanceof ProviderRefusalError) refusal = primarySettled.reason;
  else throw primarySettled.reason;

  let secondaryResult: PaidResult<MentionsOutput> | null = null;
  if (secondarySettled.status === "fulfilled") secondaryResult = secondarySettled.value;
  else if (!SECONDARY_FALLBACK.some((type) => secondarySettled.reason instanceof type)) {
    throw secondarySettled.reason;
  }

  const calls: PaidResult<MentionsOutput>[] = [];
  if (primaryResult) calls.push(primaryResult);
  if (secondaryResult) calls.push(secondaryResult);

  const primaryRefused = refusal !== null || primaryResult?.output.answerKind === "refusal";
  const primary = primaryResult
    ? toExtractedMentions(markdown, primaryResult.output)
    : { mentions: [], quoteMisses: 0 };
  const secondary = secondaryResult ? toExtractedMentions(markdown, secondaryResult.output) : null;

  let judgeResult: PaidResult<MentionsOutput> | null = null;
  let merged: Awaited<ReturnType<typeof mergeExtractions>> | null = null;
  if (!primaryRefused) {
    const found = [...primary.mentions, ...(secondary?.mentions ?? [])];
    merged = await mergeExtractions({
      markdown,
      primary: primary.mentions,
      secondary: secondary?.mentions ?? null,
      recallHints: recallHintsOf(answer, found, config.merge.nameJw),
      config,
      judge: async (disputed) => {
        judgeResult = await paidCall(
          callerFor(config.models.judge),
          {
            model: config.models.judge,
            system: JUDGE_PROMPT_V1,
            user: judgeMessage(markdown, disputed),
            schema: JudgeSchema,
            schemaName: "mentions",
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
          { timeoutMs: config.timeoutsMs.judge, retries: 0, spend },
        );
        return judgeResult.output;
      },
    });
  }
  const judged = judgeResult as PaidResult<MentionsOutput> | null;
  if (judged) calls.push(judged);

  const mentions = merged ? tagPlatforms(merged.mentions, config.platforms) : [];
  const answerKind: AnswerKind = primaryRefused
    ? "refusal"
    : mentions.length === 0
      ? "no_entities"
      : "names_entities";
  const record = (result: PaidResult<MentionsOutput> | null, model: ModelRef): CallRecord => ({
    model: result?.modelReported ?? model.model,
    output: result?.output ?? null,
    refused: result === null,
  });

  const outputs: ExtractionOutputs = {
    captureId: capture.id,
    configHash,
    primary: record(primaryResult, config.models.primary),
    secondary: secondaryResult ? record(secondaryResult, config.models.secondary) : null,
    judge: judged ? record(judged, config.models.judge) : null,
    quoteMisses: {
      primary: primary.quoteMisses,
      secondary: secondary?.quoteMisses ?? 0,
      judge: judged ? toExtractedMentions(markdown, judged.output).quoteMisses : 0,
    },
    answerKind,
    agreement: merged?.agreement ?? "single",
    disputedCount: merged?.disputedCount ?? 0,
    mentions,
    cost: sumCosts(
      [...calls.map((c) => c.cost), refusalCost(config.models.primary, refusal)],
      "USD",
    ),
    latencyMs: Date.now() - startedAt,
  };

  const bytes = new TextEncoder().encode(jcs(outputs));
  const { sha256 } = await putArtifact(ARTIFACT_KIND, bytes, { contentType: "application/json" });
  const stored = await insertExtraction({
    captureId: capture.id,
    configHash,
    outputsSha256: sha256,
    answerKind,
    agreement: outputs.agreement,
    judgeUsed: judged !== null,
    inputTokens: calls.reduce((n, c) => n + c.usage.inputTokens, 0),
    outputTokens: calls.reduce((n, c) => n + c.usage.outputTokens, 0),
    cost: outputs.cost,
    latencyMs: outputs.latencyMs,
    disputedCount: outputs.disputedCount,
  });
  if (stored.inserted) return toResult(outputs, config);

  // A concurrent run stored its extraction first; every reader gets that one.
  const winner = await findExtraction(capture.id, configHash);
  if (!winner) {
    throw new AppError("internal", { detail: `extraction of ${capture.id} vanished` });
  }
  return toResult(await storedOutputs(winner.outputsSha256), config);
}
