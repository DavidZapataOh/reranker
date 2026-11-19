import { readFileSync } from "node:fs";
import { InvalidInputError, type SpendContext, type SpendReservation } from "@reranker/jobs";
import type { BusinessCandidate, PlacesAddressComponent } from "@reranker/schema/measurement";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { FIELD_MASKS } from "../src/places/client";
import { assignCountry, findBusinessCandidates } from "../src/target";

const jobs = vi.hoisted(() => ({
  acquireProviderSlot: vi.fn(),
  reserveSpend: vi.fn(),
  settleSpend: vi.fn(async () => ({ applied: true })),
  releaseSpend: vi.fn(async () => ({ applied: true })),
  breakerRecord: vi.fn(async () => {}),
}));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  ...jobs,
}));

const db = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("@reranker/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/db")>()),
  withSystem: db.write,
  withTenant: db.write,
  withTenants: db.write,
}));

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const spend: SpendContext = {
  purpose: "free-report",
  pool: "free-report-anonymous",
  country: "CO",
  refType: "free_report",
  refId: "r1",
};
const page = (name: string) =>
  readFileSync(new URL(`fixtures/web/${name}`, import.meta.url), "utf8");

const BOGOTA: PlacesAddressComponent[] = [
  { longText: "Quinta Camacho", shortText: "Quinta Camacho", types: ["neighborhood", "political"] },
  { longText: "Chapinero", shortText: "Chapinero", types: ["sublocality_level_1", "political"] },
  { longText: "Bogotá", shortText: "Bogotá", types: ["locality", "political"] },
  { longText: "Bogotá, D.C.", shortText: "Bogotá, D.C.", types: ["administrative_area_level_1"] },
  { longText: "Colombia", shortText: "CO", types: ["country", "political"] },
];
const HAVANA: PlacesAddressComponent[] = [
  { longText: "La Habana", shortText: "La Habana", types: ["locality", "political"] },
  { longText: "Cuba", shortText: "CU", types: ["country", "political"] },
];

function place(id: string, name: string, addressComponents: PlacesAddressComponent[]) {
  return {
    id,
    displayName: { text: name, languageCode: "es" },
    formattedAddress: `${name}, ${addressComponents.map((c) => c.longText).join(", ")}`,
    addressComponents,
    location: { latitude: 4.65, longitude: -74.06 },
    types: ["bakery", "food", "store"],
    primaryType: "bakery",
    primaryTypeDisplayName: { text: "Panadería", languageCode: "es" },
    googleMapsTypeLabel: { text: "Panadería", languageCode: "es" },
    pureServiceAreaBusiness: false,
    businessStatus: "OPERATIONAL",
  };
}

let searches: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
function placesReturn(...places: ReturnType<typeof place>[]) {
  server.use(
    http.post(SEARCH_URL, async ({ request }) => {
      searches.push({
        headers: Object.fromEntries(request.headers),
        body: (await request.json()) as Record<string, unknown>,
      });
      return HttpResponse.json(places.length ? { places } : {});
    }),
  );
}
const lastSearch = () => searches.at(-1) ?? expect.fail("no Places search");

function siteServes(host: string, html: string) {
  dns.lookup.mockImplementation(async (name: string) => {
    if (name !== host) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return [{ address: "93.184.215.14", family: 4 }];
  });
  server.use(http.get(`https://${host}/`, () => HttpResponse.html(html)));
}

beforeAll(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "places-unit-key");
  server.listen();
});
beforeEach(() => {
  searches = [];
  jobs.acquireProviderSlot.mockResolvedValue({ release: async () => {} });
  jobs.reserveSpend.mockImplementation(
    async (req: { estimate: SpendReservation["reserved"] }) =>
      ({ id: "res-1", reserved: req.estimate }) as SpendReservation,
  );
  dns.lookup.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});

test("candidates: ≤ 5, measurable countries only, Pro target mask, no city bias", async () => {
  placesReturn(
    place("p1", "Panadería La Espiga", BOGOTA),
    place("p2", "La Espiga Panadería y Café", BOGOTA),
  );
  const c = await findBusinessCandidates({ query: "Panadería La Espiga", country: "CO", spend });

  expect(lastSearch().headers["x-goog-fieldmask"]).toBe(FIELD_MASKS.target);
  expect(lastSearch().body).toMatchObject({
    textQuery: "Panadería La Espiga",
    languageCode: "es",
    pageSize: 5,
    includePureServiceAreaBusinesses: true,
  });
  expect(lastSearch().body).not.toHaveProperty("locationBias");
  expect(lastSearch().body).not.toHaveProperty("locationRestriction");
  expect(c.length).toBeLessThanOrEqual(5);
  expect(c.every((x) => x.attribution === "Google Maps")).toBe(true);
  expect(c[0]).toMatchObject({
    kind: "place",
    placeId: "p1",
    domain: null,
    displayName: "Panadería La Espiga",
    categoryHint: null,
    places: {
      types: ["bakery", "food", "store"],
      primaryType: "bakery",
      primaryTypeDisplayName: "Panadería",
      googleMapsTypeLabel: "Panadería",
      pureServiceAreaBusiness: false,
    },
  });
  expect(c[0]?.geo).toMatchObject({ country: "CO", level: "city", name: "Bogotá, D.C." });
  expect(c[0]?.confidence ?? 0).toBeGreaterThan(c[1]?.confidence ?? 1);
});

test("the connection country only biases the search as its region code", async () => {
  placesReturn();
  await findBusinessCandidates({ query: "Panadería La Espiga", country: "MX", spend });
  expect(lastSearch().body).toMatchObject({ regionCode: "mx" });
  await findBusinessCandidates({ query: "Panadería La Espiga", country: null, spend });
  expect(lastSearch().body).not.toHaveProperty("regionCode");
});

test("a hit in a non-measurable country (CU) is dropped", async () => {
  placesReturn(
    place("cu1", "La Bodeguita del Medio", HAVANA),
    place("co1", "La Bodeguita", BOGOTA),
  );
  const c = await findBusinessCandidates({ query: "La Bodeguita del Medio", country: null, spend });
  expect(c.map((x) => x.placeId)).toEqual(["co1"]);
});

test("a hit without a country is dropped", async () => {
  placesReturn(place("x1", "Panadería La Espiga", BOGOTA.slice(0, 3)));
  expect(
    await findBusinessCandidates({ query: "Panadería La Espiga", country: null, spend }),
  ).toEqual([]);
});

test("neighborhood comes from sublocality_level_1 or neighborhood", async () => {
  placesReturn(
    place("p1", "Panadería La Espiga", BOGOTA),
    place("p2", "Panadería La Espiga", [...BOGOTA.slice(0, 1), ...BOGOTA.slice(2)]),
    place("p3", "Panadería La Espiga", BOGOTA.slice(2)),
  );
  const c = await findBusinessCandidates({ query: "Panadería La Espiga", country: null, spend });
  expect(c.map((x) => x.neighborhood)).toEqual(["Chapinero", "Quinta Camacho", null]);
});

test("a measurable ccTLD gives a national website candidate in that country", async () => {
  placesReturn();
  siteServes("tienda-ejemplo.com.mx", page("lang-es.html"));
  const c = await findBusinessCandidates({ query: "tienda-ejemplo.com.mx", country: "CO", spend });
  expect(c).toEqual([
    expect.objectContaining({
      kind: "website",
      domain: "tienda-ejemplo.com.mx",
      placeId: null,
      attribution: null,
      displayName: "Tienda Ejemplo & Cía",
      website: { title: "Tienda Ejemplo & Cía", siteName: null, description: "Tienda en línea." },
    }),
  ]);
  expect(c[0]?.geo).toMatchObject({ level: "country", country: "MX" });
});

test('a .com whose page says lang="es-CO" is placed in Colombia', async () => {
  placesReturn();
  siteServes("tienda-ejemplo.com", page("lang-es-co.html"));
  const [c] = await findBusinessCandidates({
    query: "https://www.tienda-ejemplo.com/",
    country: null,
    spend,
  });
  expect(c).toMatchObject({
    kind: "website",
    domain: "tienda-ejemplo.com",
    displayName: "Tienda Ejemplo",
    website: {
      title: "Tienda Ejemplo | Ropa hecha en Medellín",
      siteName: "Tienda Ejemplo",
      description: "Ropa de algodón con envíos a todo el país.",
    },
  });
  expect(c?.geo).toMatchObject({ level: "country", country: "CO" });
});

test.each([
  ["lang-es.html", "tienda-ejemplo.com"],
  ["no-lang.html", "tienda-ejemplo.com"],
  // Google treats .io as a generic domain.
  ["no-lang.html", "tienda-ejemplo.io"],
])(
  "%s on %s without a country signal gives geo null, even with a measurable connection country",
  async (fixture, host) => {
    placesReturn();
    siteServes(host, page(fixture));
    const c = await findBusinessCandidates({ query: host, country: "CO", spend });
    expect(c).toEqual([expect.objectContaining({ kind: "website", geo: null })]);
  },
);

test("a page title is trimmed and the domain names a site without one", async () => {
  placesReturn();
  siteServes("tienda-ejemplo.com", page("no-lang.html"));
  const [titled] = await findBusinessCandidates({
    query: "tienda-ejemplo.com",
    country: null,
    spend,
  });
  expect(titled?.displayName).toBe("Tienda Ejemplo");

  siteServes("tienda-ejemplo.com", "<html><body>hola</body></html>");
  const [bare] = await findBusinessCandidates({
    query: "tienda-ejemplo.com",
    country: null,
    spend,
  });
  expect(bare?.displayName).toBe("tienda-ejemplo.com");
});

test("a domain whose name Places finds gives only the place candidates", async () => {
  placesReturn(place("p1", "La Espiga", BOGOTA));
  siteServes("la-espiga.com.co", page("lang-es-co.html"));
  const c = await findBusinessCandidates({ query: "la-espiga.com.co", country: "CO", spend });
  expect(c.map((x) => x.kind)).toEqual(["place"]);
  expect(dns.lookup).not.toHaveBeenCalled();
});

test("a domain Places does not find comes first, ahead of weaker place hits", async () => {
  placesReturn(place("p1", "Espiga de Oro", BOGOTA));
  siteServes("la-espiga.com.co", page("lang-es-co.html"));
  const c = await findBusinessCandidates({ query: "la-espiga.com.co", country: "CO", spend });
  expect(c.map((x) => x.kind)).toEqual(["website", "place"]);
});

test("an unreachable domain gives no website candidate", async () => {
  placesReturn();
  expect(await findBusinessCandidates({ query: "nadie-aqui.com", country: "CO", spend })).toEqual(
    [],
  );
});

test("a domain answering other than 200 gives no website candidate", async () => {
  placesReturn();
  siteServes("tienda-ejemplo.com", "");
  server.use(
    http.get("https://tienda-ejemplo.com/", () => new HttpResponse(null, { status: 503 })),
  );
  expect(
    await findBusinessCandidates({ query: "tienda-ejemplo.com", country: null, spend }),
  ).toEqual([]);
});

test("a domain pointing at the internal network gives no website candidate", async () => {
  placesReturn();
  dns.lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
  expect(
    await findBusinessCandidates({ query: "localhost.ejemplo.co", country: null, spend }),
  ).toEqual([]);
});

test("assignCountry gives the national GeoTarget of a measurable country and refuses CU", () => {
  const webCandidate: BusinessCandidate = {
    kind: "website",
    placeId: null,
    domain: "tienda-ejemplo.com",
    displayName: "Tienda Ejemplo",
    formattedAddress: null,
    geo: null,
    neighborhood: null,
    categoryHint: null,
    confidence: 1,
    attribution: null,
  };
  expect(assignCountry(webCandidate, "PE").geo).toMatchObject({ level: "country", country: "PE" });
  expect(() => assignCountry(webCandidate, "CU" as "PE")).toThrow(InvalidInputError);
});

test.each([
  ["www.la-espiga.com.co", "la espiga"],
  ["https://panaderia_rosa.mx/menu", "panaderia rosa"],
  ["mitienda.myshopify.com", "mitienda"],
  ["Pan.de.yuca", "Pan.de.yuca"],
  ["  Panadería La Espiga  ", "Panadería La Espiga"],
])("%s is searched as %s", async (query, textQuery) => {
  placesReturn();
  await findBusinessCandidates({ query, country: null, spend });
  expect(lastSearch().body.textQuery).toBe(textQuery);
});

test("an empty query is refused before any search", async () => {
  await expect(findBusinessCandidates({ query: "  ", country: null, spend })).rejects.toThrow(
    InvalidInputError,
  );
  expect(jobs.reserveSpend).not.toHaveBeenCalled();
});

test("nothing is persisted", async () => {
  placesReturn(place("p1", "Panadería La Espiga", BOGOTA));
  siteServes("tienda-ejemplo.com", page("lang-es-co.html"));
  await findBusinessCandidates({ query: "Panadería La Espiga", country: "CO", spend });
  await findBusinessCandidates({ query: "tienda-ejemplo.com", country: "CO", spend });
  expect(db.write).not.toHaveBeenCalled();
});

test("spend is free_report with the given refId", async () => {
  placesReturn();
  await findBusinessCandidates({ query: "Panadería La Espiga", country: "CO", spend });
  expect(jobs.reserveSpend).toHaveBeenLastCalledWith(
    expect.objectContaining({ purpose: "free-report", refType: "free_report", refId: "r1" }),
  );
});

test("a Places failure propagates", async () => {
  server.use(http.post(SEARCH_URL, () => new HttpResponse(null, { status: 503 })));
  await expect(
    findBusinessCandidates({ query: "Panadería La Espiga", country: "CO", spend }),
  ).rejects.toMatchObject({ name: "ProviderUnavailable" });
});
