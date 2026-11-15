import { primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { opsTable } from "./_tables";

/** One row per alert kind per hour that was emailed; the primary key is the deduplication claim. */
export const alertDeliveries = opsTable(
  "alert_deliveries",
  {
    kind: text().notNull(),
    bucketHour: timestamp({ withTimezone: true }).notNull(),
    sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.bucketHour] })],
);
