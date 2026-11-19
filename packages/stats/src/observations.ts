import { AppError, type CaptureChannel, EngineId } from "@reranker/schema";
import {
  type EngineGeo,
  type EntityKey,
  type EntityKind,
  type IntentId,
  type MeasurementPlan,
  type PlannedObservation,
  parseSlotId,
  type RawCaptureOf,
  type ResponseExtraction,
} from "@reranker/schema/measurement";
import type { CaptureFrame, EntityColumn } from "./compare";
import { methodology } from "./methodology";

export interface ObservationFrame extends CaptureFrame {
  captures: Array<{
    captureId: string;
    engine: EngineId;
    intentId: IntentId;
    stratum: string;
    weight: number;
    isCanonical: boolean;
    present: boolean;
    namesEntities: boolean;
  }>;
  engines: Array<{
    engine: EngineId;
    planned: number;
    valid: number;
    failed: number;
    notPresent: number;
    included: boolean;
    geo: EngineGeo;
  }>;
  entities: Map<
    EntityKey,
    {
      column: EntityColumn;
      kind: EntityKind;
      isTarget: boolean;
      names: Map<string, number>;
      recommended: number;
      incidental: number;
      negative: number;
    }
  >;
  extractorConfigHash: string;
}

// Directories, media and other mentions are neither competitors nor platforms.
const KEPT_KINDS = new Set<EntityKind>(["business", "professional", "chain", "platform"]);

/** All the statistics read from a capture's answer: whether the AI surface showed. */
export type ObservedCapture = RawCaptureOf<{ present: boolean }>;

type Valid = { raw: ObservedCapture; planned: PlannedObservation; slotIndex: number };
type Entity = ObservationFrame["entities"] extends Map<EntityKey, infer E> ? E : never;

function plannedOf(plan: MeasurementPlan, raw: ObservedCapture): Valid {
  const { capture } = raw;
  const { slotIndex } = parseSlotId(capture.slotId);
  const planned = plan.observations[slotIndex];
  if (planned === undefined || planned.engine !== capture.engine) {
    throw new AppError("validation_failed", {
      detail: `capture ${capture.id} does not match slot ${capture.slotId} of the plan`,
    });
  }
  return { raw, planned, slotIndex };
}

/** One valid capture per slot: the first succeeded attempt by captureId, in plan order. */
function validCaptures(plan: MeasurementPlan, captures: readonly ObservedCapture[]): Valid[] {
  const channels = new Map<EngineId, CaptureChannel>();
  const bySlot = new Map<number, Valid>();
  for (const raw of captures) {
    const { capture } = raw;
    // The api channel is a control: its answers differ from what people see, so a rate never
    // mixes it, nor two UI channels within one engine.
    const channel = channels.get(capture.engine) ?? capture.channel;
    if (capture.channel === "api" || capture.channel !== channel) {
      throw new AppError("validation_failed", {
        detail: `capture ${capture.id} mixes the ${capture.channel} channel into the report`,
      });
    }
    channels.set(capture.engine, channel);
    const valid = plannedOf(plan, raw);
    if (capture.status !== "succeeded") continue;
    const kept = bySlot.get(valid.slotIndex);
    if (kept === undefined || capture.id < kept.raw.capture.id) bySlot.set(valid.slotIndex, valid);
  }
  return [...bySlot.values()].sort((a, b) => a.slotIndex - b.slotIndex);
}

function configHashOf(extractions: readonly ResponseExtraction[]): string {
  const hashes = new Set(extractions.map((e) => e.configHash));
  if (hashes.size !== 1) {
    // Two extractor configs would split one series in two without anyone seeing it.
    throw new AppError("internal", { detail: `${hashes.size} extractor configs in one report` });
  }
  return [...hashes][0] as string;
}

function demandWeightOf(
  intentId: IntentId,
  intentWeights: Partial<Record<IntentId, number>>,
): number {
  const w = intentWeights[intentId] ?? 1;
  if (!(Number.isFinite(w) && w > 0)) {
    throw new AppError("validation_failed", { detail: `intent ${intentId} has weight ${w}` });
  }
  return w;
}

export function buildObservations(input: {
  plan: MeasurementPlan;
  captures: ObservedCapture[];
  extractions: ResponseExtraction[];
  intentWeights?: Partial<Record<IntentId, number>>;
}): ObservationFrame {
  const { plan, extractions, intentWeights = {} } = input;
  const valid = validCaptures(plan, input.captures);
  const extractorConfigHash = configHashOf(extractions);
  if (valid.length === 0) {
    throw new AppError("provider_unavailable", { detail: "no capture of the report succeeded" });
  }

  const engines = EngineId.options.flatMap((engine) => {
    const planned = plan.observations.filter((o) => o.engine === engine);
    const first = planned[0];
    if (first === undefined) return [];
    const mine = valid.filter((v) => v.planned.engine === engine);
    const notPresent = mine.filter((v) => !v.raw.answer?.present).length;
    return [
      {
        engine,
        planned: planned.length,
        valid: mine.length,
        failed: planned.length - mine.length,
        notPresent,
        included: mine.length >= methodology.engineMinValid,
        geo: first.geoDeclared,
      },
    ];
  });
  const included = new Set(engines.filter((e) => e.included).map((e) => e.engine));
  if (included.size === 0) {
    throw new AppError("provider_unavailable", { detail: "no engine has enough valid captures" });
  }

  // W_h = (1/k) · demandWeight_i / Σ demandWeight over the engine's intents with valid captures.
  const strataOf = new Map<EngineId, Map<IntentId, number>>();
  for (const { planned } of valid) {
    const intents = strataOf.get(planned.engine) ?? new Map<IntentId, number>();
    intents.set(planned.intentId, demandWeightOf(planned.intentId, intentWeights));
    strataOf.set(planned.engine, intents);
  }
  const weights = new Map<string, number>();
  for (const [engine, intents] of strataOf) {
    const total = [...intents.values()].reduce((a, b) => a + b, 0);
    for (const [intentId, w] of intents) {
      weights.set(`${engine}|${intentId}`, included.has(engine) ? w / total / included.size : 0);
    }
  }
  const mass = [...weights.values()].reduce((a, b) => a + b, 0);

  const byCapture = new Map(extractions.map((e) => [e.captureId, e]));
  const n = valid.length;
  const entities = new Map<EntityKey, Entity>();
  const captures = valid.map(({ raw, planned }, i) => {
    const { capture, answer } = raw;
    if (answer === null) {
      throw new AppError("internal", { detail: `capture ${capture.id} succeeded without answer` });
    }
    const extraction = byCapture.get(capture.id);
    if (extraction === undefined) {
      throw new AppError("internal", { detail: `capture ${capture.id} has no extraction` });
    }

    const stances = new Map<EntityKey, "recommendation" | "negative" | "incidental">();
    for (const m of extraction.mentions) {
      if (!KEPT_KINDS.has(m.entityKind)) continue;
      let entity = entities.get(m.entityKey);
      if (entity === undefined) {
        entity = {
          column: { key: m.entityKey, y: new Uint8Array(n), ordinal: new Int16Array(n) },
          kind: m.entityKind,
          isTarget: false,
          names: new Map(),
          recommended: 0,
          incidental: 0,
          negative: 0,
        };
        entities.set(m.entityKey, entity);
      }
      entity.isTarget ||= m.isTarget;
      entity.names.set(m.name, (entity.names.get(m.name) ?? 0) + 1);
      // One answer counts once per entity, with its strongest stance and its best rank.
      const previous = stances.get(m.entityKey);
      if (m.stance === "recommendation") {
        stances.set(m.entityKey, "recommendation");
        entity.column.y[i] = 1;
        const current = entity.column.ordinal[i] as number;
        if (m.ordinal !== null && (current === 0 || m.ordinal < current)) {
          entity.column.ordinal[i] = m.ordinal;
        }
      } else if (previous === undefined || (previous === "incidental" && m.stance === "negative")) {
        stances.set(m.entityKey, m.stance);
      }
    }
    for (const [key, stance] of stances) {
      const entity = entities.get(key) as Entity;
      if (stance === "recommendation") entity.recommended++;
      else entity[stance]++;
    }

    const stratum = `${planned.engine}|${planned.intentId}`;
    return {
      captureId: capture.id,
      engine: planned.engine,
      intentId: planned.intentId,
      stratum,
      weight: (weights.get(stratum) as number) / mass,
      isCanonical: planned.isCanonical,
      present: answer.present,
      namesEntities: extraction.answerKind === "names_entities",
    };
  });

  return { captures, engines, entities, extractorConfigHash };
}
