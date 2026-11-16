import { customType } from "drizzle-orm/pg-core";

// Unqualified: drizzle-kit quotes the whole type string, so a schema prefix would name one identifier.
// The domains (in public) carry the range and currency checks, so every table that stores money gets them
// from the database and not from each caller. node-postgres returns bigint as a string; the
// domain bounds keep every stored value a safe integer, so Number never loses precision.
const amount = (domain: "amount_minor" | "amount_micros") =>
  customType<{ data: number; driverData: string | number }>({
    dataType: () => domain,
    fromDriver: (value) => Number(value),
  });

const currency = customType<{ data: string; driverData: string }>({
  dataType: () => "currency_code",
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
