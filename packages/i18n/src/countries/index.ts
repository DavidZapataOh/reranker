import type { EngineId } from "../engines";
import { DEFAULT_LOCALE } from "../locales";
import { co } from "./co";
import type { CountryCode } from "./codes";
import { PROVIDER_COVERAGE } from "./generated";
import {
  BILLING_BLOCKED,
  ENGINE_EXCLUSIONS,
  EURO_AREA,
  EURO_OFFICIAL_CURRENCY,
  EURO_TERRITORIES,
  NOT_MEASURED,
} from "./policy";

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
const UNKNOWN = { blocked: true, reason: "unknown_country" } as const;

const BILLED_IN_EUROS: readonly (readonly string[])[] = [
  EURO_AREA,
  EURO_OFFICIAL_CURRENCY,
  EURO_TERRITORIES,
];

type PaddleBilling = { readonly provider: "paddle"; readonly currency: "EUR" | "USD" };

export type Billing = typeof co.billing | PaddleBilling | typeof BLOCKED | typeof UNKNOWN;

function paddleOrBlocked(code: string): PaddleBilling | typeof BLOCKED {
  if ((BILLING_BLOCKED as readonly string[]).includes(code)) return BLOCKED;
  const currency = BILLED_IN_EUROS.some((list) => list.includes(code)) ? "EUR" : "USD";
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

function registry() {
  return {
    ...(buildCountries(PROVIDER_COVERAGE) as {
      readonly [C in GeneratedCode]: ReturnType<typeof toCountry<C>>;
    }),
    [co.code]: co,
  };
}

// Pure, so a bundle that only takes COUNTRY_CODES from this entry drops the registry's data.
export const COUNTRIES = /* @__PURE__ */ registry();

export { COUNTRY_CODES, type CountryCode } from "./codes";
export { countryForLocale } from "./profiles";
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
// Any other code outside the registry cannot pay either, with a reason a caller can tell apart.
export function billingFor(code: string): Billing {
  if ((BILLING_BLOCKED as readonly string[]).includes(code)) return BLOCKED;
  return isMeasurable(code) ? COUNTRIES[code].billing : UNKNOWN;
}
