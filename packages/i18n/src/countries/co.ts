export const co = {
  code: "CO",
  name: "Colombia",
  defaultLocale: "es-CO",
  locales: ["es-CO"],
  timeZone: "America/Bogota",
  phone: { callingCode: "57" },
  legalEntity: { name: "GLEMO S.A.S.", taxId: { type: "NIT", value: "902091972-5" } },
  identityDocumentTypes: ["CC", "CE", "NIT", "PP", "TI", "PPT"],
  dataProtection: { law: "Ley 1581 de 2012", authority: "SIC" },
  providers: {
    // ChatGPT is country-level only.
    dataforseo: { locationCode: 2170, languageCode: "es" },
    // Perplexity UI is country-level only.
    brightdata: { country: "CO" },
  },
  // Ley 2300 de 2023.
  commercialContact: {
    windows: [
      { days: [1, 2, 3, 4, 5], from: "07:00", to: "19:00" },
      { days: [6], from: "08:00", to: "15:00" },
    ],
    maxContactsPerDay: 1,
    maxChannelsPerWeek: 1,
    coldEmailAllowed: true,
  },
  // Every municipality (DIVIPOLA × DataForSEO locations).
  geoData: "co-2026.11",
  engines: ["chatgpt", "gemini", "google-ai-overview", "perplexity"],
  billing: {
    provider: "wompi",
    currency: "COP",
    tax: { regime: "co_dian", vatStandardRateBps: 1900, pricesDisplayed: "before_tax" },
    payments: { methods: ["card", "pse", "nequi"], recurringMethods: ["card"] },
    invoicing: { provider: "alegra" },
  },
} as const;
