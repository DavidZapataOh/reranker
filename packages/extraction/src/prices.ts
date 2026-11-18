import { cost, type ProviderCost } from "@reranker/schema";

/**
 * Places API (New) list price of one request per SKU, first monthly volume tier (0 to 100,000),
 * from https://developers.google.com/maps/billing-and-pricing/pricing as read on 2026-11-18.
 * Spend is reserved at list price; the monthly free usage only lowers the invoice.
 */
export const PLACES_SKU_PRICES = {
  /** Text Search Pro, 32 USD per 1,000. */
  textSearchPro: cost(32_000, "USD"),
  /** Place Details Essentials (IDs Only), unlimited and free. */
  placeDetailsIdsOnly: cost(0, "USD"),
  /** Place Details Enterprise, 20 USD per 1,000. */
  placeDetailsEnterprise: cost(20_000, "USD"),
} as const satisfies Record<string, ProviderCost>;
