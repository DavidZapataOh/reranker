import { customType } from "drizzle-orm/pg-core";

// The domains live in `app` because the migration role cannot create objects in `public` on Neon.
// drizzle-kit quotes a custom type's whole string as one identifier, so the closing and opening
// quotes around the dot make it emit "app"."name"; the schema stays explicit whatever the
// search_path. The domains carry the range and currency checks, so every table that stores money
// gets them from the database. node-postgres returns bigint as a string; the bounds keep every
// stored value a safe integer, so Number never loses precision.
const amount = (domain: "amount_minor" | "amount_micros") =>
  customType<{ data: number; driverData: string | number }>({
    dataType: () => `app"."${domain}`,
    fromDriver: (value) => Number(value),
  });

const currency = customType<{ data: string; driverData: string }>({
  dataType: () => 'app"."currency_code',
});

const amountMinor = amount("amount_minor");
const amountMicros = amount("amount_micros");

type AmountColumn = ReturnType<ReturnType<typeof amountMinor>["notNull"]>;
type CurrencyColumn = ReturnType<ReturnType<typeof currency>["notNull"]>;

/** A price or charge: whole minor units (cents) of one currency. */
export const moneyColumns = <P extends string>(prefix: P) =>
  ({
    [`${prefix}_amount_minor`]: amountMinor(`${prefix}_amount_minor`).notNull(),
    [`${prefix}_currency`]: currency(`${prefix}_currency`).notNull(),
  }) as Record<`${P}_amount_minor`, AmountColumn> & Record<`${P}_currency`, CurrencyColumn>;

/** A provider cost: non-negative micro-units (six decimals) of one currency. */
export const costMicrosColumn = <N extends string>(name: N) =>
  ({
    [`${name}_amount_micros`]: amountMicros(`${name}_amount_micros`).notNull(),
    [`${name}_currency`]: currency(`${name}_currency`).notNull(),
  }) as Record<`${N}_amount_micros`, AmountColumn> & Record<`${N}_currency`, CurrencyColumn>;
