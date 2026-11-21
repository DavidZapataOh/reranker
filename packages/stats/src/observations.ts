import { AppError, type CaptureChannel, EngineId } from "@reranker/schema";
import {
  type EngineGeo,
  type EntityKey,
  type EntityKind,
  type IntentId,
  type MeasurementLanguage,
  type MeasurementPlan,
  type PlannedObservation,
  parseSlotId,
  type RawCaptureOf,
  type ResponseExtraction,
} from "@reranker/schema/measurement";
import type { CaptureFrame, EntityColumn } from "./compare";
import { methodology } from "./methodology";

export type LanguageShares = Partial<Record<MeasurementLanguage, number>>;

export interface ObservationFrame extends CaptureFrame {
  captures: Array<{
    captureId: string;
    engine: EngineId;
    intentId: IntentId;
    /** Null in a one-language report. */
    language: MeasurementLanguage | null;
    stratum: string;
    weight: number;
    /** The stratum's weight within its engine alone, for the engine's own estimates. */
    engineWeight: number;
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
    /** `weight` is proportional to `engineWeight` over the engine's captures, so its own
     * estimates can read the report's shared bootstrap draws. */
    sharesFrame: boolean;
  }>;
  /** Empty in a one-language report. */
  languages: Array<{
    language: MeasurementLanguage;
    searchShare: number;
    planned: number;
    valid: number;
    included: boolean;
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
      /** The capture's stance, aligned with `captures`: see `STANCE`; 0 = not mentioned. */
      stance: Uint8Array;
    }
  >;
  extractorConfigHash: string;
}

// Directories, media and other mentions are neither competitors nor platforms.
const KEPT_KINDS = new Set<EntityKind>(["business", "professional", "chain", "platform"]);

export const STANCE = { recommendation: 1, incidental: 2, negative: 3 } as const;

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

interface Languages {
  main: MeasurementLanguage;
  secondary: MeasurementLanguage;
  /** Normalized to sum 1. */
  shares: Map<MeasurementLanguage, number>;
}

/** Null for a one-language plan, whose language does not enter the weights. */
function languagesOf(plan: MeasurementPlan, shares: LanguageShares): Languages | null {
  const secondary = plan.secondary?.language;
  if (secondary === undefined) return null;
  const main = plan.language;
  if (main === undefined || main === secondary) {
    throw new AppError("validation_failed", {
      detail: "a two-language plan must name its main language, distinct from the second",
    });
  }
  const counts = new Map<string, { main: number; secondary: number }>();
  for (const o of plan.observations) {
    if (o.language !== main && o.language !== secondary) {
      throw new AppError("validation_failed", {
        detail: `observation ${o.variantId} is in ${o.language ?? "no language"}, not ${main} or ${secondary}`,
      });
    }
    const c = counts.get(o.engine) ?? { main: 0, secondary: 0 };
    c[o.language === main ? "main" : "secondary"]++;
    counts.set(o.engine, c);
  }
  // The second language is sampled on a fixed floor, not in proportion to its share, so its
  // own estimate stays stable; a thinner sample would publish noise.
  for (const [engine, c] of counts) {
    if (c.secondary < methodology.secondaryLanguage.sampleFloor * c.main) {
      throw new AppError("validation_failed", {
        detail: `${engine} plans ${c.secondary} ${secondary} questions, under half of its ${c.main}`,
      });
    }
  }
  const raw = [main, secondary].map((language) => {
    const share = shares[language];
    if (share === undefined || !(Number.isFinite(share) && share > 0)) {
      throw new AppError("validation_failed", {
        detail: `language ${language} has search share ${share}`,
      });
    }
    return [language, share] as const;
  });
  const total = raw.reduce((sum, [, s]) => sum + s, 0);
  return { main, secondary, shares: new Map(raw.map(([l, s]) => [l, s / total])) };
}

interface Cell {
  engine: EngineId;
  language: MeasurementLanguage | null;
  planned: number;
  valid: number;
  included: boolean;
  /** demandWeight of each intent with a valid capture. */
  intents: Map<IntentId, number>;
}

export function buildObservations(input: {
  plan: MeasurementPlan;
  captures: ObservedCapture[];
  extractions: ResponseExtraction[];
  intentWeights?: Partial<Record<IntentId, number>>;
  /** Each language's share of the category's searches; read only in a two-language plan. */
  languageShares?: LanguageShares;
}): ObservationFrame {
  const { plan, extractions, intentWeights = {} } = input;
  const languages = languagesOf(plan, input.languageShares ?? {});
  const valid = validCaptures(plan, input.captures);
  const extractorConfigHash = configHashOf(extractions);
  if (valid.length === 0) {
    throw new AppError("provider_unavailable", { detail: "no capture of the report succeeded" });
  }

  // A cell is one engine in one language: inclusion and the engine split are decided per cell.
  const languageOf = (o: PlannedObservation) =>
    languages === null ? null : (o.language as MeasurementLanguage);
  const cellKey = (engine: EngineId, language: MeasurementLanguage | null) =>
    `${engine}|${language ?? ""}`;
  const cells = new Map<string, Cell>();
  const cellOf = (o: PlannedObservation): Cell => {
    const key = cellKey(o.engine, languageOf(o));
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        engine: o.engine,
        language: languageOf(o),
        planned: 0,
        valid: 0,
        included: false,
        intents: new Map(),
      };
      cells.set(key, cell);
    }
    return cell;
  };
  for (const o of plan.observations) cellOf(o).planned++;
  for (const { planned } of valid) {
    const cell = cellOf(planned);
    cell.valid++;
    cell.intents.set(planned.intentId, demandWeightOf(planned.intentId, intentWeights));
  }
  for (const cell of cells.values()) {
    // The second language must keep the same share of its planned answers as the main one.
    const main = languages === null ? null : cells.get(cellKey(cell.engine, languages.main));
    const minValid =
      main === null || main === undefined || cell === main
        ? methodology.engineMinValid
        : Math.ceil((methodology.engineMinValid * cell.planned) / main.planned);
    cell.included = cell.valid >= minValid;
  }
  if (![...cells.values()].some((c) => c.included)) {
    throw new AppError("provider_unavailable", { detail: "no engine has enough valid captures" });
  }

  const languageList = languages === null ? [null] : [languages.main, languages.secondary];
  const enginesIn = new Map(
    languageList.map((l) => [
      l,
      [...cells.values()].filter((c) => c.language === l && c.included).length,
    ]),
  );
  const shareOf = (l: MeasurementLanguage | null) =>
    l === null ? 1 : (languages?.shares.get(l) as number);
  // A language with no engine left gives its share to the other.
  const liveShare = languageList
    .filter((l) => (enginesIn.get(l) as number) > 0)
    .reduce((sum, l) => sum + shareOf(l), 0);

  // W_h = (s_l / k_l) · demandWeight_i / Σ demandWeight over the cell's intents with valid
  // captures, where s_l is the language's search share and k_l its number of included engines.
  // These are the fixed stratum weights of a stratified estimator, so the rate's variance is
  // Σ W_h² p_h(1 − p_h)/n_h (Cochran, Sampling Techniques, 3rd ed., 1977, eq. 5.6) and its
  // interval uses Korn and Graubard's effective size (Survey Methodology 24(2), 1998), both in
  // `effectiveSize`; the score's Monte Carlo and the bootstrap read the same W_h.
  const weights = new Map<string, number>();
  // Within one engine, s_l renormalized over the languages the engine counts in.
  const engineWeights = new Map<string, number>();
  const sharesFrame = new Map<EngineId, boolean>();
  for (const engine of EngineId.options) {
    const own = languageList.flatMap((l) => cells.get(cellKey(engine, l)) ?? []);
    const counted = own.some((c) => c.included) ? own.filter((c) => c.included) : own;
    const engineShare = counted.reduce((sum, c) => sum + shareOf(c.language), 0);
    sharesFrame.set(
      engine,
      new Set(own.filter((c) => c.included).map((c) => enginesIn.get(c.language))).size === 1,
    );
    for (const cell of own) {
      const total = [...cell.intents.values()].reduce((a, b) => a + b, 0);
      const k = enginesIn.get(cell.language) as number;
      for (const [intentId, w] of cell.intents) {
        const stratum = `${engine}|${intentId}`;
        const share = shareOf(cell.language);
        weights.set(stratum, cell.included ? ((share / liveShare) * (w / total)) / k : 0);
        engineWeights.set(
          stratum,
          counted.includes(cell) ? (share / engineShare) * (w / total) : 0,
        );
      }
    }
  }
  const mass = [...weights.values()].reduce((a, b) => a + b, 0);

  const engines = EngineId.options.flatMap((engine) => {
    const own = languageList.flatMap((l) => cells.get(cellKey(engine, l)) ?? []);
    const first = plan.observations.find((o) => o.engine === engine);
    if (first === undefined) return [];
    const mine = valid.filter((v) => v.planned.engine === engine);
    const planned = own.reduce((sum, c) => sum + c.planned, 0);
    return [
      {
        engine,
        planned,
        valid: mine.length,
        failed: planned - mine.length,
        notPresent: mine.filter((v) => !v.raw.answer?.present).length,
        included: own.some((c) => c.included),
        geo: first.geoDeclared,
        sharesFrame: sharesFrame.get(engine) as boolean,
      },
    ];
  });

  const languageRows =
    languages === null
      ? []
      : languageList.map((l) => {
          const own = [...cells.values()].filter((c) => c.language === l);
          return {
            language: l as MeasurementLanguage,
            searchShare: shareOf(l),
            planned: own.reduce((sum, c) => sum + c.planned, 0),
            valid: own.reduce((sum, c) => sum + c.valid, 0),
            included: (enginesIn.get(l) as number) > 0,
          };
        });

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
          stance: new Uint8Array(n),
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
      entity.stance[i] = STANCE[stance];
      if (stance === "recommendation") entity.recommended++;
      else entity[stance]++;
    }

    const stratum = `${planned.engine}|${planned.intentId}`;
    return {
      captureId: capture.id,
      engine: planned.engine,
      intentId: planned.intentId,
      language: languageOf(planned),
      stratum,
      weight: (weights.get(stratum) as number) / mass,
      engineWeight: engineWeights.get(stratum) as number,
      isCanonical: planned.isCanonical,
      present: answer.present,
      namesEntities: extraction.answerKind === "names_entities",
    };
  });

  return { captures, engines, languages: languageRows, entities, extractorConfigHash };
}
