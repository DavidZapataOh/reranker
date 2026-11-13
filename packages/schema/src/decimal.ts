import { CURRENCIES, type CurrencyCode } from "./currencies";
import { AppError } from "./errors/app-error";

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
// A safe integer has at most 16 digits, so no safe amount needs more characters than this; the cap
// stops attacker-sized strings before the regex and BigInt spend time on them.
const MAX_DECIMAL_LENGTH = 32;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]];

export function assertCurrency(currency: string): asserts currency is CurrencyCode {
  if (!Object.hasOwn(CURRENCIES, currency)) {
    throw new AppError("internal", { detail: "Unsupported currency" });
  }
}

export function toSafeInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new AppError("internal", { detail: "Amount exceeds the safe integer range" });
  }
  return Number(value);
}

// Exact decimal parsing on integers: floats would round silently, and amounts must never do that.
export function parseScaled(value: string | number, scale: number): bigint {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new AppError("internal", { detail: "Amount must be finite" });
  }
  const text = String(value);
  if (text.length > MAX_DECIMAL_LENGTH) {
    throw new AppError("internal", { detail: "Amount is too long to be a safe number" });
  }
  const match = DECIMAL.exec(text);
  if (!match) {
    throw new AppError("internal", { detail: "Amount must be a plain decimal number" });
  }
  const [, sign, whole = "0", fraction = ""] = match;
  const trimmed = fraction.replace(/0+$/, "");
  if (trimmed.length > scale) {
    throw new AppError("internal", { detail: "Amount has more decimals than the unit allows" });
  }
  const scaled = BigInt(whole + trimmed.padEnd(scale, "0"));
  return sign === "-" ? -scaled : scaled;
}
