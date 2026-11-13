import { CURRENCIES, type CurrencyCode } from "./currencies";
import { assertCurrency, CURRENCY_CODES, parseScaled, toSafeInteger } from "./decimal";
import { registerSchema } from "./registry";
import { z } from "./z";

export const MoneySchema = registerSchema(
  "Money",
  z.strictObject({
    amount_minor: z.int(),
    currency: z.enum(CURRENCY_CODES),
  }),
);

export type Money = z.infer<typeof MoneySchema>;

export type Rounding = "half_up" | "down";

export function money(amountMinor: number, currency: CurrencyCode): Money {
  assertCurrency(currency);
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError("Amount must be a safe integer in minor units");
  }
  return { amount_minor: amountMinor === 0 ? 0 : amountMinor, currency };
}

export function fromMajor(value: string | number, currency: CurrencyCode): Money {
  assertCurrency(currency);
  return money(toSafeInteger(parseScaled(value, CURRENCIES[currency].exponent)), currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError("Cannot combine amounts in different currencies");
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount_minor + b.amount_minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount_minor - b.amount_minor, a.currency);
}

export function sum(items: readonly Money[], currency: CurrencyCode): Money {
  return items.reduce(add, money(0, currency));
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount_minor === b.amount_minor) return 0;
  return a.amount_minor < b.amount_minor ? -1 : 1;
}

const BPS_DENOMINATOR = 10_000n;

// BigInt keeps the intermediate product exact even next to the safe-integer limit.
export function multiplyByBps(m: Money, bps: number, rounding: Rounding = "half_up"): Money {
  if (!Number.isSafeInteger(bps)) {
    throw new RangeError("Basis points must be a safe integer");
  }
  const negative = m.amount_minor < 0;
  const product = BigInt(Math.abs(m.amount_minor)) * BigInt(Math.abs(bps));
  let quotient = product / BPS_DENOMINATOR;
  if (rounding === "half_up" && (product % BPS_DENOMINATOR) * 2n >= BPS_DENOMINATOR) {
    quotient += 1n;
  }
  const signed = negative !== bps < 0 ? -quotient : quotient;
  return money(toSafeInteger(signed), m.currency);
}

// Largest remainder: leftover units go to the biggest remainders, ties to the lowest index.
export function allocate(m: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0 || weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new RangeError("Weights must be non-negative safe integers");
  }
  const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
  if (total === 0n) {
    throw new RangeError("Weights must add up to more than zero");
  }
  const amount = BigInt(Math.abs(m.amount_minor));
  const shares = weights.map((w) => (amount * BigInt(w)) / total);
  const remainders = weights.map((w, index) => ({ index, rest: (amount * BigInt(w)) % total }));
  let leftover = Number(amount - shares.reduce((acc, s) => acc + s, 0n));
  remainders.sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1));
  for (const { index } of remainders) {
    if (leftover === 0) break;
    shares[index] = (shares[index] ?? 0n) + 1n;
    leftover -= 1;
  }
  const sign = m.amount_minor < 0 ? -1n : 1n;
  return shares.map((share) => money(toSafeInteger(share * sign), m.currency));
}
