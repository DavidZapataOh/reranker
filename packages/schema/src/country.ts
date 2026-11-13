import { LOCALES } from "@reranker/i18n";
import { COUNTRIES, type CountryCode } from "@reranker/i18n/countries";
import { EngineId } from "./domain";
import { z } from "./z";

const Iso2 = z.string().regex(/^[A-Z]{2}$/);
const Locale = z.enum(LOCALES);
const HourMinute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const TimeZone = z.string().refine((timeZone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
});

const unique = (values: readonly unknown[]) => new Set(values).size === values.length;

const WompiBilling = z.strictObject({
  provider: z.enum(["wompi"]),
  currency: z.enum(["COP"]),
  tax: z.strictObject({
    regime: z.enum(["co_dian"]),
    vatStandardRateBps: z.int().min(0).max(10_000),
    pricesDisplayed: z.enum(["before_tax", "tax_included"]),
  }),
  payments: z.strictObject({
    methods: z
      .array(z.enum(["card", "pse", "nequi"]))
      .min(1)
      .readonly(),
    recurringMethods: z.array(z.enum(["card", "pse", "nequi"])).readonly(),
  }),
  invoicing: z.strictObject({ provider: z.enum(["alegra"]) }),
});

const PaddleBilling = z.strictObject({
  provider: z.enum(["paddle"]),
  currency: z.enum(["EUR", "USD"]),
});

const BlockedBilling = z.strictObject({ blocked: z.literal(true) });

const ContactWindow = z
  .strictObject({
    days: z.array(z.int().min(1).max(7)).min(1).readonly(),
    from: HourMinute,
    to: HourMinute,
  })
  .refine((window) => window.from < window.to, { path: ["to"] });

export const CountryConfig = z
  .strictObject({
    code: Iso2,
    name: z.string().min(1),
    defaultLocale: Locale,
    locales: z.array(Locale).min(1).readonly(),
    timeZone: TimeZone,
    providers: z.strictObject({
      dataforseo: z.strictObject({
        locationCode: z.int().positive(),
        languageCode: z.string().min(2).optional(),
      }),
      brightdata: z.strictObject({ country: Iso2 }).optional(),
    }),
    geoData: z.string().regex(/^[a-z]{2}-\d{4}\.\d{2}$/),
    engines: z.array(EngineId).min(1).readonly().refine(unique),
    billing: z.union([WompiBilling, PaddleBilling, BlockedBilling]),
    phone: z.strictObject({ callingCode: z.string().regex(/^\d{1,3}$/) }).optional(),
    legalEntity: z
      .strictObject({
        name: z.string().min(1),
        taxId: z.strictObject({ type: z.enum(["NIT"]), value: z.string().min(1) }),
      })
      .optional(),
    identityDocumentTypes: z
      .array(z.enum(["CC", "CE", "NIT", "PP", "TI", "PPT"]))
      .readonly()
      .optional(),
    dataProtection: z
      .strictObject({ law: z.string().min(1), authority: z.string().min(1) })
      .optional(),
    commercialContact: z
      .strictObject({
        windows: z.array(ContactWindow).min(1).readonly(),
        maxContactsPerDay: z.int().positive(),
        maxChannelsPerWeek: z.int().positive(),
        // Present only where unsolicited email to businesses is lawful.
        coldEmailAllowed: z.literal(true).optional(),
      })
      .optional(),
  })
  .refine((country) => country.locales.includes(country.defaultLocale), {
    path: ["defaultLocale"],
  });

export type CountryConfig = z.output<typeof CountryConfig>;

// Breaks the type check when a registry entry drifts from the contract.
void (COUNTRIES satisfies Record<CountryCode, z.input<typeof CountryConfig>>);
