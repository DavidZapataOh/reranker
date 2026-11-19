import type { LevelKey, Sufficiency } from "@reranker/schema/measurement";
import { sql } from "drizzle-orm";
import { check, integer, real, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { bytea, enumValues } from "./_columns";
import { publicPanelSchema } from "./_schemas";
import { sharedTable } from "./_tables";
import { measurementPlans } from "./capture";

const sha256 = (column: string) =>
  check(`estimates_${column}_length`, sql`octet_length(${sql.identifier(column)}) = 32`);

// Records keyed by the union make the compiler reject a level or sufficiency the enum misses.
const levels: Record<LevelKey, true> = {
  invisible: true,
  sometimes: true,
  on_the_list: true,
  regular: true,
};
const sufficiencies: Record<Sufficiency, true> = {
  sufficient: true,
  orientative: true,
  insufficient: true,
};
const keys = <T extends string>(record: Record<T, true>) => ({
  options: Object.keys(record) as T[],
});

export const estimateScope = publicPanelSchema.enum("estimate_scope", [
  "overall",
  "engine",
  "intent",
  "canonical",
]);
export const estimateMetric = publicPanelSchema.enum("estimate_metric", [
  "recommendation_rate",
  "prominence",
  "score",
  "names_entities_rate",
]);
export const estimateLevel = publicPanelSchema.enum("estimate_level", enumValues(keys(levels)));
export const estimateSufficiency = publicPanelSchema.enum(
  "estimate_sufficiency",
  enumValues(keys(sufficiencies)),
);

/**
 * The estimates a free report shows, one row per (measurement, entity, scope, metric). Rows are
 * immutable: a new methodology adds its own. No names or text: entities are their keys, and the
 * per-answer detail is rebuilt from the extractions with the same reproducible computation.
 */
export const estimates = sharedTable(
  "estimates",
  // Widest alignment first and variable-length last, so Postgres adds no padding inside the row.
  {
    computedAt: timestamp({ withTimezone: true }).notNull(),
    measurementId: uuid()
      .notNull()
      .references(() => measurementPlans.id),
    estimate: real().notNull(),
    lower: real().notNull(),
    upper: real().notNull(),
    effectiveTrials: real().notNull(),
    designEffect: real().notNull(),
    successes: integer().notNull(),
    trials: integer().notNull(),
    scope: estimateScope().notNull(),
    metric: estimateMetric().notNull(),
    level: estimateLevel(),
    sufficiency: estimateSufficiency(),
    // '*' for metrics of the answers themselves, such as how often an engine names anyone.
    entityKey: text().notNull(),
    // The engine or intent; null for the overall and canonical scopes.
    scopeKey: text(),
    methodologyHash: bytea().notNull(),
    intentSetHash: bytea().notNull(),
    extractorConfigHash: bytea().notNull(),
    seed: bytea().notNull(),
  },
  (t) => [
    // Leads with measurement_id, so it also serves the report lookup and the foreign key.
    unique("estimates_key")
      .on(t.measurementId, t.entityKey, t.scope, t.scopeKey, t.metric, t.methodologyHash)
      .nullsNotDistinct(),
    sha256("methodology_hash"),
    sha256("intent_set_hash"),
    sha256("extractor_config_hash"),
    sha256("seed"),
    check(
      "estimates_scope_key_check",
      sql`(${t.scopeKey} is null) = (${t.scope} in ('overall', 'canonical'))`,
    ),
    check(
      "estimates_entity_key_check",
      sql`(${t.entityKey} = '*') = (${t.metric} = 'names_entities_rate')`,
    ),
    check(
      "estimates_score_fields_check",
      sql`(${t.metric} = 'score') = (${t.level} is not null) and (${t.level} is null) = (${t.sufficiency} is null)`,
    ),
    check(
      "estimates_interval_check",
      sql`${t.lower} <= ${t.estimate} and ${t.estimate} <= ${t.upper}`,
    ),
    check(
      "estimates_counts_check",
      sql`${t.successes} >= 0 and ${t.successes} <= ${t.trials} and ${t.effectiveTrials} >= 0`,
    ),
  ],
);
