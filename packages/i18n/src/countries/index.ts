import type { EngineId } from "../engines";
import { DEFAULT_LOCALE, type Locale } from "../locales";
import { co } from "./co";
import { PROVIDER_COVERAGE } from "./generated";
import { BILLING_BLOCKED, ENGINE_EXCLUSIONS, EURO_AREA, NOT_MEASURED } from "./policy";

type CoverageCode = keyof typeof PROVIDER_COVERAGE;
type GeneratedCode = Exclude<CoverageCode, typeof co.code | (typeof NOT_MEASURED)[number]>;

export type ProviderCoverage = {
  readonly name: string;
  readonly timeZone: string;
  readonly dataforseoLocationCode: number;
  readonly brightdataCountry?: string;
  readonly engines: readonly EngineId[];
};

const BLOCKED = { blocked: true } as const;

type PaddleBilling = { readonly provider: "paddle"; readonly currency: "EUR" | "USD" };

export type Billing = typeof co.billing | PaddleBilling | typeof BLOCKED;

function paddleOrBlocked(code: string): PaddleBilling | typeof BLOCKED {
  if ((BILLING_BLOCKED as readonly string[]).includes(code)) return BLOCKED;
  const currency = (EURO_AREA as readonly string[]).includes(code) ? "EUR" : "USD";
  return { provider: "paddle", currency };
}

// Every country speaks the only shipped locale until regional profiles exist.
export function toCountry<C extends string>(code: C, coverage: ProviderCoverage) {
  const excluded: readonly EngineId[] = ENGINE_EXCLUSIONS[code as CoverageCode] ?? [];
  return {
    code,
    name: coverage.name,
    defaultLocale: DEFAULT_LOCALE,
    locales: [DEFAULT_LOCALE] as const,
    timeZone: coverage.timeZone,
    providers: {
      dataforseo: { locationCode: coverage.dataforseoLocationCode },
      ...(coverage.brightdataCountry === undefined
        ? {}
        : { brightdata: { country: coverage.brightdataCountry } }),
    },
    geoData: `${code.toLowerCase()}-2026.11`,
    engines: coverage.engines.filter((engine) => !excluded.includes(engine)),
    billing: paddleOrBlocked(code),
  } as const;
}

// Colombia is hand-written in co.ts; policy decides which covered countries are measured.
export function buildCountries(coverage: Readonly<Record<string, ProviderCoverage>>) {
  return Object.fromEntries(
    Object.entries(coverage)
      .filter(([code]) => code !== co.code && !(NOT_MEASURED as readonly string[]).includes(code))
      .map(([code, entry]) => [code, toCountry(code, entry)]),
  );
}

export const COUNTRIES = {
  ...(buildCountries(PROVIDER_COVERAGE) as {
    readonly [C in GeneratedCode]: ReturnType<typeof toCountry<C>>;
  }),
  [co.code]: co,
};

export type CountryCode = keyof typeof COUNTRIES;
export type Country = (typeof COUNTRIES)[CountryCode];

export const DEFAULT_COUNTRY_CODE: CountryCode = co.code;

export function isMeasurable(code: string): code is CountryCode {
  return Object.hasOwn(COUNTRIES, code);
}

export function getCountry<C extends CountryCode>(code: C): (typeof COUNTRIES)[C];
export function getCountry(code: string): Country;
export function getCountry(code: string): Country {
  if (!isMeasurable(code)) throw new Error(`Unknown country: ${code}`);
  return COUNTRIES[code];
}

export function measurableCountries(): readonly Country[] {
  return Object.values(COUNTRIES);
}

// Blocked countries answer even when they are not measurable, so checkout never offers them.
export function billingFor(code: string): Billing {
  if ((BILLING_BLOCKED as readonly string[]).includes(code)) return BLOCKED;
  return getCountry(code).billing;
}

// A locale belongs to the country of its region subtag, never to a neighbor sharing it.
export function countryForLocale(locale: Locale): CountryCode {
  const region = new Intl.Locale(locale).region;
  if (
    region &&
    isMeasurable(region) &&
    (getCountry(region).locales as readonly string[]).includes(locale)
  ) {
    return region;
  }
  throw new Error(`No country for locale: ${locale}`);
}
