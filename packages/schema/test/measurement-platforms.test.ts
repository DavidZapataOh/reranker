import { expect, test } from "vitest";
import { type PlatformEntry, platformOfUrl } from "../src/measurement/platforms";
import { isGoogleRedirect } from "../src/measurement/redirects";

const slugOf = (url: string, registry?: readonly PlatformEntry[]) =>
  platformOfUrl(url, registry)?.slug ?? null;

test("a URL maps to its platform on any subdomain and country domain", () => {
  expect(slugOf("https://www.doctoralia.co/dra-ana")).toBe("doctoralia");
  expect(slugOf("https://es.tripadvisor.com.mx/Restaurant")).toBe("tripadvisor");
  expect(slugOf("https://m.facebook.com/negocio")).toBe("facebook");
  expect(slugOf("https://www.instagram.com/negocio/")).toBe("instagram");
});

test("hosts match label-wise and path-scoped domains only under their path", () => {
  expect(slugOf("https://notbooking.com/")).toBeNull();
  expect(slugOf("https://www.google.com/maps/place/Sonrisas")).toBe("google-maps");
  expect(slugOf("https://www.google.com/maps")).toBe("google-maps");
  expect(slugOf("https://www.google.com/mapsy")).toBeNull();
  expect(slugOf("https://www.google.com/search?q=x")).toBeNull();
  expect(slugOf("https://maps.google.com./?cid=1")).toBe("google-maps");
});

test("a URL that does not parse belongs to no platform", () => {
  expect(slugOf("not a url")).toBeNull();
});

test("a custom registry replaces the default one", () => {
  const registry: PlatformEntry[] = [
    { slug: "acme", names: ["Acme"], domains: ["acme.test/listings"], kind: "platform" },
  ];
  expect(slugOf("https://acme.test/listings/1", registry)).toBe("acme");
  expect(slugOf("https://www.doctoralia.co/", registry)).toBeNull();
});

test("Google's redirects are recognized by prefix", () => {
  expect(
    isGoogleRedirect("https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC"),
  ).toBe(true);
  expect(isGoogleRedirect("https://google.com/goto?url=CAES")).toBe(true);
  expect(isGoogleRedirect("https://www.google.com/goto?url=CAES")).toBe(true);
  expect(isGoogleRedirect("https://www.google.com/search?q=goto")).toBe(false);
  expect(isGoogleRedirect("https://example.com/https://google.com/goto?")).toBe(false);
});
