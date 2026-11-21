import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  integer,
  jsonb,
  real,
  smallint,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { bytea } from "./_columns";
import { publicPanelSchema } from "./_schemas";
import { sharedTable } from "./_tables";
import { captureChannel, captureEngine, captureProvider, captures } from "./capture";

const at = () => timestamp({ withTimezone: true });
const sha256 = (table: string, column: string) =>
  check(`${table}_${column}_length`, sql`octet_length(${sql.identifier(column)}) = 32`);

export const regimeCause = publicPanelSchema.enum("regime_cause", ["initial", "model", "drift"]);

/**
 * The model an engine answered with, per channel and provider, and when it changed. A regime
 * opens on a reported model change or on drift the control canary detects.
 */
export const modelRegimes = sharedTable(
  "model_regimes",
  {
    openedAt: at().notNull(),
    firstSeenAt: at().notNull(),
    lastSeenAt: at().notNull(),
    captureCount: integer().notNull().default(0),
    engine: captureEngine().notNull(),
    channel: captureChannel().notNull(),
    provider: captureProvider().notNull(),
    cause: regimeCause().notNull(),
    modelReported: text(),
    firstCaptureId: text().references(() => captures.id),
    detail: jsonb(),
    envelopeSha256: bytea(),
  },
  (t) => [
    // Also serves the latest-regime lookup: a btree index reads opened_at backwards.
    unique("model_regimes_key").on(t.engine, t.channel, t.provider, t.openedAt),
    sha256("model_regimes", "envelope_sha256"),
    check("model_regimes_capture_count_check", sql`${t.captureCount} >= 0`),
    check("model_regimes_seen_check", sql`${t.firstSeenAt} <= ${t.lastSeenAt}`),
  ],
);

/** One metric of one control canary day per engine and channel; a null prompt is the engine's. */
export const controlDaily = sharedTable(
  "control_daily",
  {
    day: date().notNull(),
    engine: captureEngine().notNull(),
    channel: captureChannel().notNull(),
    value: real().notNull(),
    n: smallint().notNull(),
    geoKey: text().notNull(),
    promptId: text(),
    metric: text().notNull(),
    extractorConfigHash: bytea(),
  },
  (t) => [
    unique("control_daily_key")
      .on(t.day, t.engine, t.channel, t.geoKey, t.promptId, t.metric)
      .nullsNotDistinct(),
    sha256("control_daily", "extractor_config_hash"),
    check("control_daily_n_check", sql`${t.n} >= 0`),
  ],
);

/** The day's CUSUM and BOCPD summary of one canary cell: prompt, engine and channel. */
export const canaryCusum = sharedTable(
  "canary_cusum",
  {
    day: date().notNull(),
    engine: captureEngine().notNull(),
    channel: captureChannel().notNull(),
    x: real().notNull(),
    sUp: real().notNull(),
    sDown: real().notNull(),
    y: smallint().notNull(),
    n: smallint().notNull(),
    mapRunLength: smallint().notNull(),
    alarm: boolean().notNull(),
    promptId: text().notNull(),
  },
  (t) => [
    unique("canary_cusum_key").on(t.day, t.engine, t.channel, t.promptId),
    check(
      "canary_cusum_counts_check",
      sql`${t.n} > 0 and ${t.y} >= 0 and ${t.y} <= ${t.n} and ${t.mapRunLength} >= 0`,
    ),
  ],
);

/** The current BOCPD run-length posterior of each cell; earlier days keep only their summary. */
export const canaryBocpd = sharedTable("canary_bocpd", {
  day: date().notNull(),
  cell: text().notNull().unique("canary_bocpd_cell_key"),
  state: jsonb().notNull(),
});

/**
 * A cell's in-control reference: its three most recommended entities over 42 complete days with
 * one extractor config, and the CUSUM parameters fitted on them. No variation leaves mu0, sigma
 * and h null.
 */
export const canaryBaselines = sharedTable(
  "canary_baselines",
  {
    fromDay: date().notNull(),
    toDay: date().notNull(),
    engine: captureEngine().notNull(),
    channel: captureChannel().notNull(),
    p0: real().notNull(),
    mu0: real(),
    sigma: real(),
    h: real(),
    promptId: text().notNull(),
    // Entity keys; a person is named only by the keyed hash of the name.
    referenceEntities: text().array().notNull(),
    extractorConfigHash: bytea().notNull(),
  },
  (t) => [
    unique("canary_baselines_key").on(t.engine, t.channel, t.promptId, t.extractorConfigHash),
    sha256("canary_baselines", "extractor_config_hash"),
    check("canary_baselines_days_check", sql`${t.fromDay} <= ${t.toDay}`),
    check("canary_baselines_p0_check", sql`${t.p0} >= 0 and ${t.p0} <= 1`),
    check(
      "canary_baselines_fit_check",
      sql`(${t.mu0} is null) = (${t.sigma} is null) and (${t.sigma} is null) = (${t.h} is null) and (${t.sigma} is null or ${t.sigma} > 0)`,
    ),
  ],
);
