// No engine is officially offered in Cuba and Google Maps Platform lists it as a prohibited
// territory: https://cloud.google.com/maps-platform/terms/maps-prohibited-territories
export const NOT_MEASURED = ["CU"] as const;

// OpenAI does not offer ChatGPT in Venezuela, so a proxied answer measures nothing local:
// https://help.openai.com/en/articles/7947663-chatgpt-supported-countries
export const ENGINE_EXCLUSIONS: Readonly<Record<string, readonly string[]>> = { VE: ["chatgpt"] };

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
