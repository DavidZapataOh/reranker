import { expect, test } from "vitest";
import { PLATFORMS, type PlatformEntry, platformOfUrl } from "../src/measurement/platforms";
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

test("the host index picks the rule a scan of the registry in order would", () => {
  const scan = (raw: string) => {
    const url = new URL(raw);
    for (const entry of PLATFORMS) {
      for (const domain of entry.domains) {
        const [host, ...rest] = domain.split("/");
        const path = rest.length > 0 ? `/${rest.join("/")}` : "";
        const onHost = url.hostname === host || url.hostname.endsWith(`.${host}`);
        const onPath = !path || url.pathname === path || url.pathname.startsWith(`${path}/`);
        if (onHost && onPath) return entry.slug;
      }
    }
    return null;
  };
  for (const entry of PLATFORMS) {
    for (const domain of entry.domains) {
      for (const url of [`https://${domain}`, `https://www.${domain}/x`, `https://a.b.${domain}`]) {
        expect(slugOf(url), url).toBe(scan(url));
      }
    }
  }
});

test("a parsed URL is read without parsing it again", () => {
  expect(platformOfUrl(new URL("https://www.doctoralia.co/x"))?.slug).toBe("doctoralia");
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
