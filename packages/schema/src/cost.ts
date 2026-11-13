import type { CurrencyCode } from "./currencies";
import { assertCurrency, CURRENCY_CODES, parseScaled, toSafeInteger } from "./decimal";
import { AppError } from "./errors/app-error";
import { registerSchema } from "./registry";
import { z } from "./z";

const MICROS_SCALE = 6;

export const ProviderCostSchema = registerSchema(
  "ProviderCost",
  z.strictObject({
    amount_micros: z.int().nonnegative(),
    currency: z.enum(CURRENCY_CODES),
  }),
);

export type ProviderCost = Readonly<z.infer<typeof ProviderCostSchema>>;

export function cost(amountMicros: number, currency: CurrencyCode): ProviderCost {
  assertCurrency(currency);
  if (!Number.isSafeInteger(amountMicros) || amountMicros < 0) {
    throw new AppError("internal", {
      detail: "Cost must be a non-negative safe integer in micro-units",
    });
  }
  return { amount_micros: amountMicros, currency };
}

export function costFromMajor(value: string, currency: CurrencyCode): ProviderCost {
  return cost(toSafeInteger(parseScaled(value, MICROS_SCALE)), currency);
}

function assertSameCurrency(a: ProviderCost, b: ProviderCost): void {
  if (a.currency !== b.currency) {
    throw new AppError("internal", { detail: "Cannot combine costs in different currencies" });
  }
}

export function addCost(a: ProviderCost, b: ProviderCost): ProviderCost {
  assertSameCurrency(a, b);
  return cost(a.amount_micros + b.amount_micros, a.currency);
}

export function sumCosts(items: readonly ProviderCost[], currency: CurrencyCode): ProviderCost {
  return items.reduce(addCost, cost(0, currency));
}

export function compareCost(a: ProviderCost, b: ProviderCost): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount_micros === b.amount_micros) return 0;
  return a.amount_micros < b.amount_micros ? -1 : 1;
}
