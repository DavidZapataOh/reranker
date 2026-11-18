import { sql } from "drizzle-orm";
import { customType, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./auth";

// drizzle-orm 0.45 has no bytea builder; node-postgres reads and writes bytea as Buffer.
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);

export const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

export const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** SHA-256 of a capability token; the token itself never reaches the database. */
export const capabilityHash = (name: string) => bytea(name).notNull().unique();
