export const CURRENCIES = ["cop", "eur", "usd"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const DEFAULT_CURRENCY: Currency = "usd";

// Euro area members plus the states that use the euro as their official currency.
const EURO_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "DE",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PT",
  "SI",
  "SK",
  "AD",
  "MC",
  "ME",
  "SM",
  "VA",
  "XK",
]);

/** Currency shown to a visitor, from the ISO 3166-1 alpha-2 country the edge reports. */
export function currencyForCountry(country: string | null | undefined): Currency {
  const code = country?.trim().toUpperCase();
  if (code === "CO") return "cop";
  if (code && EURO_COUNTRIES.has(code)) return "eur";
  return DEFAULT_CURRENCY;
}

type Prices = { essential: number; pro: number; agencies: number };

/** Monthly list prices. */
export const PRICES: Record<Currency, Prices> = {
  cop: { essential: 149_000, pro: 299_000, agencies: 249_000 },
  eur: { essential: 45, pro: 95, agencies: 179 },
  usd: { essential: 39, pro: 79, agencies: 69 },
};

export const ISO_CODE: Record<Currency, "COP" | "EUR" | "USD"> = {
  cop: "COP",
  eur: "EUR",
  usd: "USD",
};

const amount = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 });

/** Prices always carry their currency, so "$149.000" is never read as a local amount. */
export function formatPrice(currency: Currency, value: number): string {
  const n = amount.format(value);
  if (currency === "cop") return `COP ${n}`;
  if (currency === "eur") return `€${n}`;
  return `US$${n}`;
}

export const PAYMENT_METHODS: Record<Currency, string> = {
  cop: "PSE, Nequi o tarjeta",
  eur: "tarjeta, Apple Pay o Google Pay",
  usd: "tarjeta, Apple Pay o Google Pay",
};
