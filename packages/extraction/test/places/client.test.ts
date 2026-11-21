import { readFileSync } from "node:fs";
import {
  ProviderRejectedError,
  ProviderUnavailableError,
  RateLimitedError,
  type SpendContext,
  type SpendReservation,
} from "@reranker/jobs";
import { cost } from "@reranker/schema";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { FIELD_MASKS, placeDetails, searchText } from "../../src/places/client";

const jobs = vi.hoisted(() => ({
  release: vi.fn(async () => {}),
  acquireProviderSlot: vi.fn(),
  reserveSpend: vi.fn(),
  settleSpend: vi.fn(async () => ({ applied: true })),
  releaseSpend: vi.fn(async () => ({ applied: true })),
  breakerRecord: vi.fn(async (_provider: string, _outcome: "success" | "failure") => {}),
}));

vi.mock("@reranker/jobs", async (importOriginal) => {
  const { release: _, ...doubles } = jobs;
  return { ...(await importOriginal<typeof import("@reranker/jobs")>()), ...doubles };
});

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const DETAILS_URL = "https://places.googleapis.com/v1/places/:placeId";
const API_KEY = "places-unit-key";
const spend: SpendContext = {
  purpose: "free-report",
  pool: "free-report-anonymous",
  country: "CO",
  refType: "report",
  refId: "rep_01",
};
const search = (textQuery = "a") =>
  searchText({ textQuery, mask: "resolve", languageCode: "es" }, spend);

function capture(url: string, reply: () => Response = () => HttpResponse.json({})) {
  const seen: { method: string; url: string; headers: Record<string, string>; body: unknown }[] =
    [];
  server.use(
    http.all(url, async ({ request }) => {
      const text = request.method === "GET" ? "" : await request.text();
      const headers = Object.fromEntries(request.headers);
      seen.push({
        method: request.method,
        url: request.url,
        headers,
        body: text && JSON.parse(text),
      });
      return reply();
    }),
  );
  return seen;
}

function googleError(status: number, code: string, headers?: Record<string, string>) {
  const error = { code: status, message: "secret detail from the body", status: code };
  return () => HttpResponse.json({ error }, { status, ...(headers && { headers }) });
}

beforeAll(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("GOOGLE_PLACES_API_KEY", API_KEY);
  server.listen();
});
beforeEach(() => {
  jobs.acquireProviderSlot.mockResolvedValue({ release: jobs.release });
  jobs.reserveSpend.mockImplementation(
    async (req: { estimate: SpendReservation["reserved"] }) =>
      ({ id: "res-1", reserved: req.estimate }) as SpendReservation,
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});

test("resolution search sends exactly the Pro mask and the fixed body", async () => {
  const seen = capture(SEARCH_URL);
  await searchText(
    {
      textQuery: "Clínica Sonrisas Pereira",
      mask: "resolve",
      languageCode: "es",
      regionCode: "co",
    },
    spend,
  );
  expect(seen[0]?.method).toBe("POST");
  expect(seen[0]?.headers).toMatchObject({
    "x-goog-fieldmask": FIELD_MASKS.resolve,
    "x-goog-api-key": API_KEY,
    "content-type": "application/json",
  });
  expect(seen[0]?.body).toEqual({
    textQuery: "Clínica Sonrisas Pereira",
    languageCode: "es",
    pageSize: 5,
    regionCode: "co",
  });
});

test("target search passes its optional filters and no region it was not given", async () => {
  const seen = capture(SEARCH_URL);
  const filters = {
    includedType: "dentist",
    locationBias: { circle: { center: { latitude: 4.81, longitude: -75.69 }, radius: 5000 } },
    includePureServiceAreaBusinesses: true,
  };
  await searchText(
    { textQuery: "Odontología Pereira", mask: "target", languageCode: "es", ...filters },
    spend,
  );
  expect(seen[0]?.headers["x-goog-fieldmask"]).toBe(FIELD_MASKS.target);
  expect(seen[0]?.body).toEqual({
    textQuery: "Odontología Pereira",
    languageCode: "es",
    pageSize: 5,
    ...filters,
  });
});

test("no search mask ever asks for an Enterprise field", () => {
  for (const mask of [FIELD_MASKS.resolve, FIELD_MASKS.target]) {
    expect(mask).not.toMatch(/websiteUri|regularOpeningHours|rating|nationalPhoneNumber/);
  }
});

test("a resolution hit carries only the Pro fields, with absent ones as null", async () => {
  const full = {
    id: "ChIJa",
    formattedAddress: "Cra. 7 #20-30, Pereira, Risaralda",
    types: ["dentist", "health"],
    primaryType: "dentist",
    businessStatus: "OPERATIONAL",
  };
  capture(SEARCH_URL, () =>
    HttpResponse.json({
      places: [
        { ...full, displayName: { text: "Clínica Sonrisas", languageCode: "es" } },
        { id: "ChIJb", displayName: { text: "Sonrisas Dental" } },
      ],
    }),
  );
  expect(await search()).toEqual([
    { ...full, displayName: "Clínica Sonrisas" },
    {
      id: "ChIJb",
      displayName: "Sonrisas Dental",
      formattedAddress: null,
      types: [],
      primaryType: null,
      businessStatus: null,
    },
  ]);
  // Text Search answers `{}` when nothing matches.
  capture(SEARCH_URL);
  expect(await search("zzzz")).toEqual([]);
});

test("a target hit adds address components, location and the type labels", async () => {
  const addressComponents = [
    { longText: "Pereira", shortText: "Pereira", types: ["locality", "political"] },
  ];
  const location = { latitude: 4.81, longitude: -75.69 };
  capture(SEARCH_URL, () =>
    HttpResponse.json({
      places: [
        {
          id: "ChIJa",
          displayName: { text: "Clínica Sonrisas" },
          addressComponents,
          location,
          primaryTypeDisplayName: { text: "Dentista", languageCode: "es" },
          googleMapsTypeLabel: { text: "Odontólogo", languageCode: "es" },
          pureServiceAreaBusiness: true,
        },
        { id: "ChIJb", displayName: { text: "Sonrisas Centro" } },
      ],
    }),
  );
  const [first, second] = await searchText(
    { textQuery: "a", mask: "target", languageCode: "es" },
    spend,
  );
  expect(first).toMatchObject({
    addressComponents,
    location,
    primaryTypeDisplayName: "Dentista",
    googleMapsTypeLabel: "Odontólogo",
    pureServiceAreaBusiness: true,
  });
  expect(second).toMatchObject({
    addressComponents: [],
    primaryTypeDisplayName: null,
    googleMapsTypeLabel: null,
    pureServiceAreaBusiness: false,
  });
  expect(second).not.toHaveProperty("location");
});

test.each(["mexico-city", "madrid", "havana"])(
  "the recorded %s search parses, empty fields included",
  async (city) => {
    const body = readFileSync(
      new URL(`../fixtures/recorded/sandbox/places-search-text-${city}.json`, import.meta.url),
      "utf8",
    );
    capture(
      SEARCH_URL,
      () => new HttpResponse(body, { headers: { "Content-Type": "application/json" } }),
    );
    const hits = await searchText({ textQuery: "a", mask: "target", languageCode: "es" }, spend);
    expect(hits.length).toBeGreaterThan(0);
    for (const component of hits.flatMap((hit) => hit.addressComponents ?? [])) {
      expect(component).toMatchObject({ shortText: expect.any(String), types: expect.any(Array) });
    }
  },
);

test("an address component without a short name or types keeps empty ones", async () => {
  capture(SEARCH_URL, () =>
    HttpResponse.json({
      places: [
        {
          id: "ChIJa",
          addressComponents: [
            { longText: "Vedado", languageCode: "es" },
            { longText: "Cuba", shortText: "CU", types: ["country", "political"] },
          ],
        },
      ],
    }),
  );
  const [hit] = await searchText({ textQuery: "a", mask: "target", languageCode: "es" }, spend);
  expect(hit?.addressComponents).toEqual([
    { longText: "Vedado", shortText: "", types: [], languageCode: "es" },
    { longText: "Cuba", shortText: "CU", types: ["country", "political"] },
  ]);
});

test("details masks are the IDs-only and the two Enterprise ones", async () => {
  const hours = { periods: [{ open: { day: 1, hour: 8, minute: 0 } }] };
  // Enterprise masks do not ask for the id, so those responses carry none.
  const replies: Record<string, object> = {
    "id,movedPlaceId": { id: "ChIJa", movedPlaceId: "ChIJmoved" },
    websiteUri: { websiteUri: "https://sonrisas.co/" },
    "regularOpeningHours,websiteUri": { regularOpeningHours: hours },
  };
  const seen: string[][] = [];
  server.use(
    http.get(DETAILS_URL, ({ request }) => {
      const mask = request.headers.get("x-goog-fieldmask") ?? "";
      seen.push([new URL(request.url).pathname, mask, request.headers.get("x-goog-api-key") ?? ""]);
      return HttpResponse.json(replies[mask]);
    }),
  );
  expect(await placeDetails("ChIJa", "idsOnly", spend)).toEqual({
    id: "ChIJa",
    movedPlaceId: "ChIJmoved",
  });
  expect(await placeDetails("ChIJa", "website", spend)).toEqual({
    id: "ChIJa",
    websiteUri: "https://sonrisas.co/",
  });
  expect(await placeDetails("ChIJa", "findings", spend)).toEqual({
    id: "ChIJa",
    regularOpeningHours: hours,
  });
  expect(seen).toEqual([
    ["/v1/places/ChIJa", "id,movedPlaceId", API_KEY],
    ["/v1/places/ChIJa", "websiteUri", API_KEY],
    ["/v1/places/ChIJa", "regularOpeningHours,websiteUri", API_KEY],
  ]);
});

test("a place id is sent as one path segment", async () => {
  const seen = capture("https://places.googleapis.com/v1/places/*", () =>
    HttpResponse.json({ id: "a/b" }),
  );
  await placeDetails("a/b", "idsOnly", spend);
  expect(new URL(seen[0]?.url ?? "").pathname).toBe("/v1/places/a%2Fb");
});

test("a 404 detail returns null; 429 → RateLimited; 5xx → ProviderUnavailable", async () => {
  capture(DETAILS_URL, googleError(404, "NOT_FOUND"));
  await expect(placeDetails("ChIJgone", "idsOnly", spend)).resolves.toBeNull();

  capture(SEARCH_URL, googleError(429, "RESOURCE_EXHAUSTED", { "Retry-After": "7" }));
  const limited = search();
  await expect(limited).rejects.toBeInstanceOf(RateLimitedError);
  await expect(limited).rejects.toMatchObject({ retryAfterMs: 7000 });

  capture(SEARCH_URL, googleError(503, "UNAVAILABLE"));
  await expect(search()).rejects.toBeInstanceOf(ProviderUnavailableError);
  capture(DETAILS_URL, googleError(500, "INTERNAL"));
  await expect(placeDetails("ChIJa", "website", spend)).rejects.toBeInstanceOf(
    ProviderUnavailableError,
  );
  capture(SEARCH_URL, () => HttpResponse.error());
  await expect(search()).rejects.toBeInstanceOf(ProviderUnavailableError);
});

test("any other refusal is ProviderRejected with Google's status and none of the body", async () => {
  capture(SEARCH_URL, googleError(400, "INVALID_ARGUMENT"));
  const rejected = search();
  await expect(rejected).rejects.toBeInstanceOf(ProviderRejectedError);
  await expect(rejected).rejects.toMatchObject({ providerCode: "INVALID_ARGUMENT" });
  await expect(rejected).rejects.not.toThrow(/secret detail/);

  capture(SEARCH_URL, () => new HttpResponse("<html>Forbidden</html>", { status: 403 }));
  await expect(search()).rejects.toMatchObject({ providerCode: "http_403" });

  capture(SEARCH_URL, () => HttpResponse.json({ places: [{ displayName: { text: "Sin id" } }] }));
  const malformed = search();
  await expect(malformed).rejects.toThrow(/Places.*: places\.0\.id invalid_type/);
  await expect(malformed).rejects.not.toThrow(/Sin id/);
});

test("each call settles the price of its SKU", async () => {
  capture(SEARCH_URL, () => HttpResponse.json({ places: [{ id: "ChIJa" }] }));
  capture(DETAILS_URL, () => HttpResponse.json({ id: "ChIJa" }));

  await search();
  expect(jobs.reserveSpend).toHaveBeenCalledWith({
    provider: "google_places",
    estimate: cost(32_000, "USD"),
    ...spend,
  });
  expect(jobs.settleSpend).toHaveBeenCalledWith(
    expect.objectContaining({ id: "res-1" }),
    cost(32_000, "USD"),
  );

  vi.clearAllMocks();
  await placeDetails("ChIJa", "idsOnly", spend);
  expect(jobs.acquireProviderSlot).toHaveBeenCalledOnce();
  expect(jobs.release).toHaveBeenCalledOnce();
  expect(jobs.reserveSpend).not.toHaveBeenCalled();
  expect(jobs.settleSpend).not.toHaveBeenCalled();

  for (const mask of ["website", "findings"] as const) {
    vi.clearAllMocks();
    await placeDetails("ChIJa", mask, spend);
    const enterprise = cost(20_000, "USD");
    expect(jobs.reserveSpend).toHaveBeenCalledWith(
      expect.objectContaining({ estimate: enterprise }),
    );
    expect(jobs.settleSpend).toHaveBeenCalledWith(expect.anything(), enterprise);
  }
});

test("a refused request gives the reservation back; one lost in flight keeps it", async () => {
  capture(SEARCH_URL, googleError(400, "INVALID_ARGUMENT"));
  await expect(search()).rejects.toThrow();
  expect(jobs.releaseSpend).toHaveBeenCalledOnce();
  expect(jobs.settleSpend).not.toHaveBeenCalled();

  vi.clearAllMocks();
  capture(DETAILS_URL, () => HttpResponse.error());
  await expect(placeDetails("ChIJa", "website", spend)).rejects.toThrow();
  expect(jobs.settleSpend).toHaveBeenCalledWith(expect.anything(), cost(20_000, "USD"));
  expect(jobs.releaseSpend).not.toHaveBeenCalled();
});

test("only outages count against the breaker", async () => {
  const outcomes = async (reply: () => Response) => {
    vi.clearAllMocks();
    capture(SEARCH_URL, reply);
    await search().catch(() => {});
    return jobs.breakerRecord.mock.calls.map(([, outcome]) => outcome);
  };
  expect(await outcomes(() => HttpResponse.json({}))).toEqual(["success"]);
  expect(await outcomes(googleError(400, "INVALID_ARGUMENT"))).toEqual(["success"]);
  expect(await outcomes(googleError(429, "RESOURCE_EXHAUSTED"))).toEqual(["success"]);
  expect(await outcomes(googleError(502, "UNAVAILABLE"))).toEqual(["failure"]);
  expect(await outcomes(() => HttpResponse.error())).toEqual(["failure"]);
});

test("the slot is taken for every call and given back when it fails", async () => {
  capture(SEARCH_URL, googleError(503, "UNAVAILABLE"));
  await expect(search()).rejects.toThrow();
  expect(jobs.acquireProviderSlot).toHaveBeenCalledWith(
    "google_places",
    expect.objectContaining({ maxInFlight: expect.any(Number) }),
  );
  expect(jobs.release).toHaveBeenCalledOnce();

  vi.clearAllMocks();
  const seen = capture(SEARCH_URL);
  jobs.reserveSpend.mockRejectedValueOnce(new Error("cap"));
  await expect(search()).rejects.toThrow("cap");
  expect(seen).toHaveLength(0);
  expect(jobs.release).toHaveBeenCalledOnce();
});

test("type labels come only in the asked language", async () => {
  const seen = capture(SEARCH_URL, () =>
    HttpResponse.json({
      places: [
        {
          id: "ChIJa",
          primaryTypeDisplayName: { text: "Boulangerie", languageCode: "fr" },
          googleMapsTypeLabel: { text: "Bakery", languageCode: "en" },
        },
        { id: "ChIJb", primaryTypeDisplayName: { text: "Bäckerei", languageCode: "de-DE" } },
      ],
    }),
  );
  const [fr, de] = await searchText({ textQuery: "a", mask: "target", languageCode: "fr" }, spend);
  expect(seen[0]?.body).toMatchObject({ languageCode: "fr" });
  expect(fr).toMatchObject({ primaryTypeDisplayName: "Boulangerie", googleMapsTypeLabel: null });
  expect(de).toMatchObject({ primaryTypeDisplayName: null });
});
