import { CountryCode } from "@reranker/schema";

export function countryFromGeoKey(geoKey: string): CountryCode | null {
  const parsed = CountryCode.safeParse(geoKey.slice(0, 2).toUpperCase());
  return parsed.success ? parsed.data : null;
}
