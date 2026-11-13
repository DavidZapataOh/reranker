import type { EngineId } from "../engines";
import type { PROVIDER_COVERAGE } from "./generated";

type CoverageCode = keyof typeof PROVIDER_COVERAGE;

// No engine is officially offered in Cuba and Google Maps Platform lists it as a prohibited
// territory: https://cloud.google.com/maps-platform/terms/maps-prohibited-territories
export const NOT_MEASURED = ["CU"] as const;

// Territories with no permanent population or businesses, no capital in GeoNames and either
// no IANA zone (HM) or several (AQ, UM), so no single local time exists. The generator skips
// them; any other country without a resolvable zone stops it.
// https://download.geonames.org/export/dump/ · https://data.iana.org/time-zones/tzdb/zone.tab
export const UNINHABITED_TERRITORIES = ["AQ", "HM", "UM"] as const;

// OpenAI does not offer ChatGPT in Venezuela, so a proxied answer measures nothing local:
// https://help.openai.com/en/articles/7947663-chatgpt-supported-countries
export const ENGINE_EXCLUSIONS: Readonly<Partial<Record<CoverageCode, readonly EngineId[]>>> = {
  VE: ["chatgpt"],
};

// Paddle's unsupported countries (https://www.paddle.com/help/legal/sanctions/which-countries-are-supported-by-paddle,
// read 2026-11-12); the Netherlands Antilles are listed by their successors CW, SX and BQ.
// Cuba, Venezuela and Nicaragua are on it and Wompi is not offered to them either.
export const BILLING_BLOCKED = [
  "AF",
  "AQ",
  "BQ",
  "BY",
  "CD",
  "CF",
  "CU",
  "CW",
  "HT",
  "IQ",
  "IR",
  "KP",
  "LY",
  "ML",
  "MM",
  "NI",
  "RU",
  "SD",
  "SO",
  "SS",
  "SX",
  "SY",
  "VE",
  "YE",
  "ZW",
] as const;

// Euro area members: https://european-union.europa.eu/institutions-law-budget/euro/countries-using-euro_en
// (read 2026-11-12).
export const EURO_AREA = [
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
] as const;

// States outside the euro area whose official currency is the euro, by monetary agreement
// (AD, MC, SM, VA) or de facto (ME, XK): https://economy-finance.ec.europa.eu/euro/use-euro/euro-outside-euro-area_en
// (read 2026-11-12). Only those the providers cover become countries; XK is not covered yet.
export const EURO_OFFICIAL_CURRENCY = ["AD", "MC", "ME", "SM", "VA", "XK"] as const;

// Territories with their own ISO code whose official currency is the euro: the French overseas
// departments and collectivities served by IEDOM (https://www.iedom.fr/Nos-territoires-d-intervention-et-nos-agences?lang=en,
// read 2026-11-12) and Åland (https://visitaland.com/en/practical-info/aland-in-brief/, read 2026-11-12).
// Only MF, PM and TF are covered by the providers today.
export const EURO_TERRITORIES = [
  "AX",
  "BL",
  "GF",
  "GP",
  "MF",
  "MQ",
  "PM",
  "RE",
  "TF",
  "YT",
] as const;
