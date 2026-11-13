export const CURRENCIES = {
  COP: { exponent: 2, displayFractionDigits: 0 },
  USD: { exponent: 2, displayFractionDigits: 2 },
  EUR: { exponent: 2, displayFractionDigits: 2 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;
