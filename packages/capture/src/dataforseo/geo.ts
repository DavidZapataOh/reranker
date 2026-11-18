import { getCountry } from "@reranker/i18n/countries";
import { InvalidInputError } from "@reranker/jobs/errors";
import type { EngineId } from "@reranker/schema";
import type { GeoTarget, QuestionScope } from "@reranker/schema/measurement";

export type DataForSeoGeo = {
  location_code?: number;
  location_coordinate?: string;
  device?: "mobile";
  os?: "android";
};

// Gemini's radius is in millimetres (199 to 199,999); the widest keeps the municipality around
// its centroid instead of one street.
const GEMINI_RADIUS_MM = 199_999;
// DataForSEO accepts at most 7 decimals per coordinate.
const COORDINATE_DECIMALS = 7;
// Local questions are mostly asked from a phone, and Google lays out (and grounds) its answers
// per device.
const MOBILE = { device: "mobile", os: "android" } as const;

/** Where DataForSEO asks an engine from: the same location `geoForEngine` declares for it. */
export function geoFields(
  engine: EngineId,
  target: GeoTarget,
  scope: QuestionScope,
): DataForSeoGeo {
  const country = getCountry(target.country).providers.dataforseo.locationCode;
  const national = scope === "national" || target.level === "country";
  switch (engine) {
    case "google-ai-overview":
    case "google-ai-mode":
      return { location_code: national ? country : target.dataforseo.locationCode, ...MOBILE };
    case "gemini": {
      if (national || !target.center) return { location_code: country };
      const { lat, lng } = target.center;
      return {
        location_coordinate: `${lat.toFixed(COORDINATE_DECIMALS)},${lng.toFixed(COORDINATE_DECIMALS)},${GEMINI_RADIUS_MM}`,
      };
    }
    case "chatgpt":
      return { location_code: country };
    case "perplexity":
      throw new InvalidInputError("Perplexity is not captured through DataForSEO");
  }
}
