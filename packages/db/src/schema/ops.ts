import { sql } from "drizzle-orm";
import {
  check,
  cidr,
  date,
  doublePrecision,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { id } from "./_columns";
import { costMicrosColumn } from "./_money";
import { opsTable } from "./_tables";

// The counters, buckets, leases, breaker and guard modes change only through the ops.* functions,
// which hold the locking rules; Drizzle declares their shape and the reads.

const at = () => timestamp({ withTimezone: true });

/** One row per alert kind per hour that was emailed; the primary key is the deduplication claim. */
export const alertDeliveries = opsTable(
  "alert_deliveries",
  {
    kind: text().notNull(),
    bucketHour: at().notNull(),
    sentAt: at().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.bucketHour] })],
);

/** Idempotent workflow starts: the first caller to claim (kind, key) starts the run. */
export const workflowStarts = opsTable(
  "workflow_starts",
  {
    kind: text().notNull(),
    key: text().notNull(),
    runId: text(),
    status: text().notNull().default("pending"),
    createdAt: at().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.key] }),
    check("workflow_starts_status_check", sql`${t.status} in ('pending', 'started')`),
  ],
);

/** The row each provider account's lease acquisition locks. */
export const leasePools = opsTable("lease_pools", {
  key: text().primaryKey(),
  maxInFlight: integer().notNull(),
});

/** In-flight provider calls; expires_at frees the slot of a function that died holding it. */
export const concurrencyLeases = opsTable(
  "concurrency_leases",
  {
    leaseId: uuid().primaryKey().default(sql`uuidv7()`),
    key: text().notNull(),
    expiresAt: at().notNull(),
  },
  (t) => [index("concurrency_leases_key_expires_at_idx").on(t.key, t.expiresAt)],
);

/** Token buckets; the balance is refilled lazily from updated_at on every read. */
export const rateBuckets = opsTable("rate_buckets", {
  key: text().primaryKey(),
  tokens: doublePrecision().notNull(),
  updatedAt: at().notNull(),
});

/** Daily spend per scope (global, provider:*, purpose:*, pool:*), in the country's day. */
export const spendCounters = opsTable(
  "spend_counters",
  {
    day: date().notNull(),
    scope: text().notNull(),
    ...costMicrosColumn("cap"),
    ...costMicrosColumn("used"),
  },
  (t) => [primaryKey({ columns: [t.day, t.scope] })],
);

const actual = costMicrosColumn("actual");

/** One row per reservation; scopes and pool are the ones actually charged, fallback included. */
export const spendLedger = opsTable(
  "spend_ledger",
  {
    id: id(),
    day: date().notNull(),
    provider: text().notNull(),
    channel: text(),
    engine: text(),
    purpose: text().notNull(),
    pool: text(),
    scopes: text().array().notNull(),
    refType: text().notNull(),
    refId: text().notNull(),
    ...costMicrosColumn("reserved"),
    // Meaningful only once status is settled; a released reservation keeps 0.
    actual_amount_micros: actual.actual_amount_micros.default(0),
    actual_currency: actual.actual_currency,
    status: text().notNull().default("reserved"),
    createdAt: at().notNull().defaultNow(),
    settledAt: at(),
  },
  (t) => [
    index("spend_ledger_ref_type_ref_id_idx").on(t.refType, t.refId),
    index("spend_ledger_day_provider_idx").on(t.day, t.provider),
    index("spend_ledger_reserved_day_created_at_idx")
      .on(t.day, t.createdAt)
      .where(sql`${t.status} = 'reserved'`),
    check("spend_ledger_status_check", sql`${t.status} in ('reserved', 'settled', 'released')`),
  ],
);

/** Ten-second outcome buckets per provider account; the breaker reads the last minute. */
export const breakerWindows = opsTable(
  "breaker_windows",
  {
    provider: text().notNull(),
    account: text().notNull(),
    bucketStart: at().notNull(),
    calls: integer().notNull().default(0),
    failures: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.provider, t.account, t.bucketStart] })],
);

export const breakerState = opsTable(
  "breaker_state",
  {
    provider: text().notNull(),
    account: text().notNull(),
    openUntil: at(),
    probeUntil: at(),
    openedAt: at(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.account] })],
);

/** Daily quotas with a fixed allocation per priority. */
export const quotaCounters = opsTable(
  "quota_counters",
  {
    day: date().notNull(),
    name: text().notNull(),
    priority: text().notNull(),
    used: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.name, t.priority] }),
    check(
      "quota_counters_priority_check",
      sql`${t.priority} in ('critical', 'high', 'normal', 'low')`,
    ),
  ],
);

export const opportunisticRuns = opsTable("opportunistic_runs", {
  name: text().primaryKey(),
  lastRunAt: at().notNull(),
});

/** One-minute admission counters; keys are opaque (HMAC), never an address. */
export const velocityBuckets = opsTable(
  "velocity_buckets",
  {
    key: text().notNull(),
    bucketStart: at().notNull(),
    count: integer().notNull().default(0),
    flagged: integer().notNull().default(0),
    ...costMicrosColumn("spend"),
  },
  (t) => [primaryKey({ columns: [t.key, t.bucketStart] })],
);

export const velocityBaselines = opsTable("velocity_baselines", {
  key: text().primaryKey(),
  computedOn: date().notNull(),
  p95Count10m: integer("p95_count_10m").notNull(),
  ...costMicrosColumn("p95_spend_10m"),
  ...costMicrosColumn("p95_spend_60m"),
});

/** Protective modes tripped by code and released lazily once active_until passes. */
export const guardModes = opsTable("guard_modes", {
  name: text().primaryKey(),
  activeUntil: at(),
  trippedAt: at().notNull(),
  reason: text().notNull(),
  releasedAt: at(),
});

/** Public datacenter and VPN ranges of companies; no address of a person is stored. */
export const networkRanges = opsTable(
  "network_ranges",
  {
    prefix: cidr().primaryKey(),
    kind: text().notNull(),
  },
  (t) => [
    index("network_ranges_prefix_gist_idx").using("gist", t.prefix.op("inet_ops")),
    check("network_ranges_kind_check", sql`${t.kind} in ('hosting', 'vpn')`),
  ],
);

/** One row per upstream commit loaded; the current list is the latest refreshed_at. */
export const networkRangesMeta = opsTable("network_ranges_meta", {
  sourceCommit: text().primaryKey(),
  rows: integer().notNull(),
  refreshedAt: at().notNull().defaultNow(),
});
