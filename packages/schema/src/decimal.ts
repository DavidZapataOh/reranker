import { CURRENCIES, type CurrencyCode } from "./currencies";

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]];

export function assertCurrency(currency: string): asserts currency is CurrencyCode {
  if (!Object.hasOwn(CURRENCIES, currency)) {
    throw new TypeError("Unsupported currency");
  }
}

export function toSafeInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError("Amount exceeds the safe integer range");
  }
  return Number(value);
}

// Exact decimal parsing on integers: floats would round silently, and amounts must never do that.
export function parseScaled(value: string | number, scale: number): bigint {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new RangeError("Amount must be finite");
  }
  const match = DECIMAL.exec(String(value));
  if (!match) {
    throw new TypeError("Amount must be a plain decimal number");
  }
  const [, sign, whole = "0", fraction = ""] = match;
  const trimmed = fraction.replace(/0+$/, "");
  if (trimmed.length > scale) {
    throw new RangeError("Amount has more decimals than the unit allows");
  }
  const scaled = BigInt(whole + trimmed.padEnd(scale, "0"));
  return sign === "-" ? -scaled : scaled;
}
