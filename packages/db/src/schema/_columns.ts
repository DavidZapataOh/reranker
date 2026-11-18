import { sql } from "drizzle-orm";
import { customType, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./auth";

// drizzle-orm 0.45 has no bytea builder; node-postgres reads and writes bytea as Buffer.
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// drizzle-kit drops the schema of an enum built from an object, so the values go in as a tuple;
// a zod enum always has at least one option.
export const enumValues = <T extends string>(zodEnum: { options: T[] }) =>
  zodEnum.options as [T, ...T[]];

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
