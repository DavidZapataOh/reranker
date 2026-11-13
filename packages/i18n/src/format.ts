import { billingFor, countryForLocale } from "./countries/index";
import { CURRENCIES, type CurrencyCode } from "./currencies";
import { defaultTimeZone } from "./formats";
import type { Locale } from "./locales";
import { getTranslator } from "./translator";

export { getFormats } from "./formats";

export type FormatOptions = { readonly locale: Locale; readonly timeZone?: string };

export type MoneyFormatOptions = FormatOptions & {
  // ISO 3166-1 alpha-2 country of the visitor; null when unknown. Omitted means the locale's country.
  readonly viewerCountry?: string | null;
};

export type PercentFormatOptions = FormatOptions & { readonly maximumFractionDigits?: number };

// Structural shapes of Money and ProviderCost: this package sits below @reranker/schema.
type MoneyAmount = { readonly amount_minor: number; readonly currency: CurrencyCode };
type CostAmount = { readonly amount_micros: number; readonly currency: CurrencyCode };

const COST_EXPONENT = 6;
const NO_BREAK_SPACE = " ";

// Intl formatters are expensive to build and immutable, so each configuration is built once.
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const rangeTranslators = new Map<Locale, ReturnType<typeof getTranslator<"common">>>();

function numberFormat(locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}

function dateFormat(opts: FormatOptions, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const timeZone = opts.timeZone ?? defaultTimeZone(opts.locale);
  const key = `${opts.locale}|${timeZone}|${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(opts.locale, { ...options, timeZone });
    dateFormats.set(key, format);
  }
  return format;
}

// Intl formats decimal strings exactly; dividing by 10^exponent in floating point would not.
function toDecimal(amount: number, exponent: number): Intl.StringNumericLiteral {
  if (!Number.isSafeInteger(amount))
    throw new RangeError(`Amount is not a safe integer: ${amount}`);
  const digits = Math.abs(amount)
    .toString()
    .padStart(exponent + 1, "0");
  const sign = amount < 0 ? "-" : "";
  const cut = digits.length - exponent;
  return `${sign}${digits.slice(0, cut)}.${digits.slice(cut)}` as Intl.StringNumericLiteral;
}

// The currency a country is charged in; countries that cannot pay have none.
function chargedCurrency(country: string): CurrencyCode | undefined {
  const billing = billingFor(country);
  return "currency" in billing ? billing.currency : undefined;
}

// "$" alone is read as the visitor's own currency, so outside its country the code is shown.
function currencyDisplay(currency: CurrencyCode, opts: MoneyFormatOptions): "symbol" | "code" {
  // Edge headers arrive in arbitrary case and the registry lookup is exact.
  const country =
    opts.viewerCountry === undefined
      ? countryForLocale(opts.locale)
      : (opts.viewerCountry?.trim().toUpperCase() ?? null);
  return country !== null && chargedCurrency(country) === currency ? "symbol" : "code";
}

export function formatMoney(money: MoneyAmount, opts: MoneyFormatOptions): string {
  const { currency } = money;
  const digits = CURRENCIES[currency].displayFractionDigits;
  return numberFormat(opts.locale, {
    style: "currency",
    currency,
    currencyDisplay: currencyDisplay(currency, opts),
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(toDecimal(money.amount_minor, CURRENCIES[currency].exponent));
}

export function formatCost(cost: CostAmount, opts: FormatOptions): string {
  return numberFormat(opts.locale, {
    style: "currency",
    currency: cost.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: COST_EXPONENT,
  }).format(toDecimal(cost.amount_micros, COST_EXPONENT));
}

export function formatDate(value: Date | string, opts: FormatOptions): string {
  return dateFormat(opts, { dateStyle: "long" }).format(new Date(value));
}

export function formatDateTime(value: Date | string, opts: FormatOptions): string {
  return dateFormat(opts, { dateStyle: "long", timeStyle: "short" }).format(new Date(value));
}

export function formatNumber(value: number, opts: FormatOptions): string {
  return numberFormat(opts.locale, {}).format(value);
}

// The RAE's Ortografía separates the figure and "%" with a no-break space; ICU's es-CO data does not.
export function formatPercent(ratio: number, opts: PercentFormatOptions): string {
  if (!Number.isFinite(ratio)) throw new TypeError(`Ratio must be a finite number: ${ratio}`);
  const options: Intl.NumberFormatOptions = { style: "percent" };
  if (opts.maximumFractionDigits !== undefined) {
    options.maximumFractionDigits = opts.maximumFractionDigits;
  }
  const parts = numberFormat(opts.locale, options).formatToParts(ratio);
  let text = "";
  for (const part of parts) {
    if (part.type === "percentSign" && text !== "" && !/[-−]$/.test(text)) {
      text = `${text.trimEnd()}${NO_BREAK_SPACE}${part.value}`;
    } else {
      text += part.value;
    }
  }
  return text;
}

export function formatPercentRange(lo: number, hi: number, opts: PercentFormatOptions): string {
  let t = rangeTranslators.get(opts.locale);
  if (!t) {
    t = getTranslator(opts.locale, "common");
    rangeTranslators.set(opts.locale, t);
  }
  return t("range.percent", { lo: formatPercent(lo, opts), hi: formatPercent(hi, opts) });
}
