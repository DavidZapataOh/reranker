import { DEFAULT_LOCALE } from "@reranker/i18n";
import { billingFor, isMeasurable } from "@reranker/i18n/countries";

export const CURRENCIES = ["cop", "eur", "usd"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const DEFAULT_CURRENCY: Currency = "usd";

const lower = <C extends string>(code: C) => code.toLowerCase() as Lowercase<C>;

/** ISO 4217 code of a landing currency. */
export const isoCode = (currency: Currency) => currency.toUpperCase() as Uppercase<Currency>;

/**
 * Currency shown to a visitor, from the ISO 3166-1 alpha-2 country the edge reports: the one
 * checkout charges there. Countries that cannot pay or are unknown see dollars.
 */
export function currencyForCountry(country: string | null | undefined): Currency {
  const code = country?.trim().toUpperCase();
  if (!code || !isMeasurable(code)) return DEFAULT_CURRENCY;
  const billing = billingFor(code);
  return "currency" in billing ? lower(billing.currency) : DEFAULT_CURRENCY;
}

type Prices = { essential: number; pro: number; agencies: number };

/** Monthly list prices. */
export const PRICES: Record<Currency, Prices> = {
  cop: { essential: 149_000, pro: 299_000, agencies: 249_000 },
  eur: { essential: 45, pro: 95, agencies: 179 },
  usd: { essential: 39, pro: 79, agencies: 69 },
};

const amount = new Intl.NumberFormat(DEFAULT_LOCALE, { maximumFractionDigits: 0 });

/** Prices always carry their currency, so "$149.000" is never read as a local amount. */
export function formatPrice(currency: Currency, value: number): string {
  const n = amount.format(value);
  if (currency === "cop") return `${isoCode(currency)} ${n}`;
  if (currency === "eur") return `€${n}`;
  return `US$${n}`;
}

export const PAYMENT_METHODS: Record<Currency, string> = {
  cop: "PSE, Nequi o tarjeta",
  eur: "tarjeta, Apple Pay o Google Pay",
  usd: "tarjeta, Apple Pay o Google Pay",
};
