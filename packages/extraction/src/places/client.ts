import { defineEnv } from "@reranker/env";
import {
  acquireProviderSlot,
  breakerRecord,
  loadJobsConfig,
  ProviderRejectedError,
  ProviderUnavailableError,
  RateLimitedError,
  releaseSpend,
  reserveSpend,
  type SpendContext,
  type SpendReservation,
  settleSpend,
} from "@reranker/jobs";
import { type ProviderCost, z } from "@reranker/schema";
import type { MeasurementLanguage, PlacesAddressComponent } from "@reranker/schema/measurement";
import { extractionEnv } from "../env";
import { PLACES_SKU_PRICES } from "../prices";

// Every search field is Pro at most and every detail mask is either the free IDs Only SKU or one
// Enterprise field set, so each call bills exactly one known SKU
// (https://developers.google.com/maps/documentation/places/web-service/text-search).
export const FIELD_MASKS = {
  resolve:
    "places.id,places.displayName,places.formattedAddress,places.types,places.primaryType,places.businessStatus",
  target:
    "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.location,places.types,places.primaryType,places.primaryTypeDisplayName,places.googleMapsTypeLabel,places.pureServiceAreaBusiness,places.businessStatus",
  idsOnly: "id,movedPlaceId",
  website: "websiteUri",
  findings: "regularOpeningHours,websiteUri",
} as const;

export interface PlaceHit {
  id: string;
  displayName: string;
  formattedAddress: string | null;
  types: string[];
  primaryType: string | null;
  businessStatus: string | null;
  addressComponents?: PlacesAddressComponent[];
  location?: { latitude: number; longitude: number };
  primaryTypeDisplayName?: string | null;
  googleMapsTypeLabel?: string | null;
  pureServiceAreaBusiness?: boolean;
}

export interface SearchTextRequest {
  textQuery: string;
  mask: "resolve" | "target";
  /** The measurement language: type labels, addresses and the geocoder's reading follow it. */
  languageCode: MeasurementLanguage;
  regionCode?: string;
  includedType?: string;
  locationBias?:
    | { circle: { center: LatLng; radius: number } }
    | { rectangle: { low: LatLng; high: LatLng } };
  includePureServiceAreaBusinesses?: boolean;
}

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface PlaceDetails {
  id: string;
  movedPlaceId?: string;
  websiteUri?: string;
  regularOpeningHours?: unknown;
}

const BASE_URL = "https://places.googleapis.com/v1";
const TIMEOUT_MS = 3000;
// Google sends no Retry-After on most refusals; one second spreads the retries of a burst.
const DEFAULT_RETRY_AFTER_MS = 1000;
const PAGE_SIZE = 5;

const DETAIL_PRICES = {
  idsOnly: PLACES_SKU_PRICES.placeDetailsIdsOnly,
  website: PLACES_SKU_PRICES.placeDetailsEnterprise,
  findings: PLACES_SKU_PRICES.placeDetailsEnterprise,
} as const;

// Proto3 JSON leaves out empty fields: a Havana hotel came with an address component that has
// neither a short name nor types.
const LocalizedText = z.object({
  text: z.string().default(""),
  languageCode: z.string().optional(),
});
const AddressComponent = z.object({
  longText: z.string().default(""),
  shortText: z.string().default(""),
  types: z.array(z.string()).default([]),
  languageCode: z.string().optional(),
});

const PlaceSchema = z.object({
  id: z.string().min(1),
  displayName: LocalizedText.optional(),
  formattedAddress: z.string().optional(),
  types: z.array(z.string()).optional(),
  primaryType: z.string().optional(),
  businessStatus: z.string().optional(),
  addressComponents: z.array(AddressComponent).optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  primaryTypeDisplayName: LocalizedText.optional(),
  googleMapsTypeLabel: LocalizedText.optional(),
  pureServiceAreaBusiness: z.boolean().optional(),
});

const SearchResponse = z.object({ places: z.array(PlaceSchema).optional() });

const DetailsResponse = z.object({
  id: z.string().optional(),
  movedPlaceId: z.string().optional(),
  websiteUri: z.string().optional(),
  regularOpeningHours: z.unknown().optional(),
});

const ErrorResponse = z.object({ error: z.object({ status: z.string() }) });

// Only the Places key, so a caller of this client needs no LLM keys.
const placesKeyEnv = extractionEnv.pick({ GOOGLE_PLACES_API_KEY: true });
let apiKey: string | undefined;

const headers = (fieldMask: string): Record<string, string> => {
  apiKey ??= defineEnv([placesKeyEnv]).GOOGLE_PLACES_API_KEY;
  return {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": apiKey,
    "X-Goog-FieldMask": fieldMask,
  };
};

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
}

// Only Google's status code leaves the body: messages can echo the query text.
async function rejectionCode(response: Response): Promise<string> {
  const body = await response.json().catch(() => undefined);
  return ErrorResponse.safeParse(body).data?.error.status ?? `http_${response.status}`;
}

// Paths and issue codes only: a value can echo the query text.
function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => `${i.path.join(".")} ${i.code}`).join(", ");
  throw new Error(`Places returned a response without the requested fields: ${issues}`);
}

/**
 * One billed request under a Places slot. A refusal is not billed, so its reservation goes back;
 * a request lost in flight may have been served, so it keeps the list price.
 */
async function call(
  url: string,
  init: { method: "GET" | "POST"; fieldMask: string; body?: unknown },
  price: ProviderCost,
  spend: SpendContext,
): Promise<Response | null> {
  const slot = await acquireProviderSlot("google_places", loadJobsConfig().limits.google_places);
  try {
    // The IDs Only SKU is free and unlimited, and a zero reservation is refused.
    const reservation: SpendReservation | null =
      price.amount_micros === 0
        ? null
        : await reserveSpend({ provider: "google_places", estimate: price, ...spend });

    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        headers: headers(init.fieldMask),
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      if (reservation) await settleSpend(reservation, reservation.reserved);
      await breakerRecord("google_places", "failure");
      throw new ProviderUnavailableError("google_places", DEFAULT_RETRY_AFTER_MS);
    }

    if (response.ok) {
      if (reservation) await settleSpend(reservation, reservation.reserved);
      await breakerRecord("google_places", "success");
      return response;
    }
    if (reservation) await releaseSpend(reservation);
    const outage = response.status >= 500;
    await breakerRecord("google_places", outage ? "failure" : "success");
    if (outage) throw new ProviderUnavailableError("google_places", retryAfterMs(response));
    if (response.status === 429) throw new RateLimitedError(retryAfterMs(response), "Places");
    if (response.status === 404) return null;
    throw new ProviderRejectedError("google_places", await rejectionCode(response));
  } finally {
    await slot.release();
  }
}

/** Text Search (New) on the Pro SKU; `pageSize` is fixed, region only if given. */
export async function searchText(req: SearchTextRequest, spend: SpendContext): Promise<PlaceHit[]> {
  const { mask, ...params } = req;
  const response = await call(
    `${BASE_URL}/places:searchText`,
    {
      method: "POST",
      fieldMask: FIELD_MASKS[mask],
      body: { ...params, pageSize: PAGE_SIZE },
    },
    PLACES_SKU_PRICES.textSearchPro,
    spend,
  );
  if (!response) throw new ProviderRejectedError("google_places", "NOT_FOUND");
  const { places = [] } = parsed(SearchResponse, await response.json());
  return places.map((place) => toHit(place, req));
}

type Localized = z.infer<typeof LocalizedText> | undefined;

// "If a name is not available in the preferred language, the API uses the closest match": a type
// label in another language would name the business in the wrong one.
function inLanguage(label: Localized, language: MeasurementLanguage): string | null {
  if (!label?.text || !label.languageCode) return null;
  return label.languageCode.split("-")[0]?.toLowerCase() === language ? label.text : null;
}

function toHit(place: z.infer<typeof PlaceSchema>, req: SearchTextRequest): PlaceHit {
  const hit: PlaceHit = {
    id: place.id,
    displayName: place.displayName?.text ?? "",
    formattedAddress: place.formattedAddress ?? null,
    types: place.types ?? [],
    primaryType: place.primaryType ?? null,
    businessStatus: place.businessStatus ?? null,
  };
  if (req.mask === "resolve") return hit;
  return {
    ...hit,
    addressComponents: place.addressComponents ?? [],
    ...(place.location && { location: place.location }),
    primaryTypeDisplayName: inLanguage(place.primaryTypeDisplayName, req.languageCode),
    googleMapsTypeLabel: inLanguage(place.googleMapsTypeLabel, req.languageCode),
    pureServiceAreaBusiness: place.pureServiceAreaBusiness ?? false,
  };
}

/** Place Details (New); null when the id no longer exists. */
export async function placeDetails(
  placeId: string,
  mask: "idsOnly" | "website" | "findings",
  spend: SpendContext,
): Promise<PlaceDetails | null> {
  const response = await call(
    `${BASE_URL}/places/${encodeURIComponent(placeId)}`,
    { method: "GET", fieldMask: FIELD_MASKS[mask] },
    DETAIL_PRICES[mask],
    spend,
  );
  if (!response) return null;
  const { id, movedPlaceId, websiteUri, regularOpeningHours } = parsed(
    DetailsResponse,
    await response.json(),
  );
  return {
    // Enterprise masks do not ask for `id`, so the asked id stands in.
    id: id ?? placeId,
    ...(movedPlaceId !== undefined && { movedPlaceId }),
    ...(websiteUri !== undefined && { websiteUri }),
    ...(regularOpeningHours !== undefined && { regularOpeningHours }),
  };
}
