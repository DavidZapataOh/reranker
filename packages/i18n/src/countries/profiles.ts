import type { Locale } from "../locales";
import { co } from "./co";
import type { CountryCode } from "./codes";

// Only hand-written profiles own a locale, so locale lookups (every translator needs a time zone)
// never load the generated registry into a client bundle.
const PROFILES = { [co.code]: co } as const;

type Profile = (typeof PROFILES)[keyof typeof PROFILES];

// A locale belongs to the country of its region subtag, never to a neighbor sharing it.
export function profileForLocale(locale: Locale): Profile {
  const region = new Intl.Locale(locale).region;
  const profile: Profile | undefined =
    region && Object.hasOwn(PROFILES, region)
      ? PROFILES[region as keyof typeof PROFILES]
      : undefined;
  if (profile && (profile.locales as readonly string[]).includes(locale)) return profile;
  throw new Error(`No country for locale: ${locale}`);
}

export function countryForLocale(locale: Locale): CountryCode {
  return profileForLocale(locale).code;
}
