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

vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  acquireProviderSlot: jobs.acquireProviderSlot,
  reserveSpend: jobs.reserveSpend,
  settleSpend: jobs.settleSpend,
  releaseSpend: jobs.releaseSpend,
  breakerRecord: jobs.breakerRecord,
}));

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

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function capture(url: string, reply: () => Response = () => HttpResponse.json({})) {
  const seen: Captured[] = [];
  server.use(
    http.all(url, async ({ request }) => {
      const text = request.method === "GET" ? "" : await request.text();
      seen.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: text ? JSON.parse(text) : undefined,
      });
      return reply();
    }),
  );
  return seen;
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
    { textQuery: "Clínica Sonrisas Pereira", mask: "resolve", regionCode: "co" },
    spend,
  );
  const [req] = seen;
  expect(req?.method).toBe("POST");
  expect(req?.headers["x-goog-fieldmask"]).toBe(FIELD_MASKS.resolve);
  expect(req?.headers["x-goog-api-key"]).toBe(API_KEY);
  expect(req?.headers["content-type"]).toBe("application/json");
  expect(req?.body).toEqual({
    textQuery: "Clínica Sonrisas Pereira",
    languageCode: "es",
    pageSize: 5,
    regionCode: "co",
  });
});

test("target search passes its optional filters and never a region it was not given", async () => {
  const seen = capture(SEARCH_URL);
  const locationBias = { circle: { center: { latitude: 4.81, longitude: -75.69 }, radius: 5000 } };
  await searchText(
    {
      textQuery: "Odontología Pereira",
      mask: "target",
      includedType: "dentist",
      locationBias,
      includePureServiceAreaBusinesses: true,
    },
    spend,
  );
  expect(seen[0]?.headers["x-goog-fieldmask"]).toBe(FIELD_MASKS.target);
  expect(seen[0]?.body).toEqual({
    textQuery: "Odontología Pereira",
    languageCode: "es",
    pageSize: 5,
    includedType: "dentist",
    locationBias,
    includePureServiceAreaBusinesses: true,
  });
});

test("no search mask ever asks for an Enterprise field", () => {
  for (const mask of [FIELD_MASKS.resolve, FIELD_MASKS.target]) {
    expect(mask).not.toMatch(/websiteUri|regularOpeningHours|rating|nationalPhoneNumber/);
  }
});

test("a resolution hit carries only the Pro fields, with absent ones as null", async () => {
  capture(SEARCH_URL, () =>
    HttpResponse.json({
      places: [
        {
          id: "ChIJa",
          displayName: { text: "Clínica Sonrisas", languageCode: "es" },
          formattedAddress: "Cra. 7 #20-30, Pereira, Risaralda",
          types: ["dentist", "health"],
          primaryType: "dentist",
          businessStatus: "OPERATIONAL",
        },
        { id: "ChIJb", displayName: { text: "Sonrisas Dental" } },
      ],
    }),
  );
  const hits = await searchText({ textQuery: "Clínica Sonrisas", mask: "resolve" }, spend);
  expect(hits).toEqual([
    {
      id: "ChIJa",
      displayName: "Clínica Sonrisas",
      formattedAddress: "Cra. 7 #20-30, Pereira, Risaralda",
      types: ["dentist", "health"],
      primaryType: "dentist",
      businessStatus: "OPERATIONAL",
    },
    {
      id: "ChIJb",
      displayName: "Sonrisas Dental",
      formattedAddress: null,
      types: [],
      primaryType: null,
      businessStatus: null,
    },
  ]);
});

test("a target hit adds address components, location and the type labels", async () => {
  const addressComponents = [
    { longText: "Pereira", shortText: "Pereira", types: ["locality", "political"] },
  ];
  capture(SEARCH_URL, () =>
    HttpResponse.json({
      places: [
        {
          id: "ChIJa",
          displayName: { text: "Clínica Sonrisas" },
          addressComponents,
          location: { latitude: 4.81, longitude: -75.69 },
          primaryTypeDisplayName: { text: "Dentista", languageCode: "es" },
          googleMapsTypeLabel: { text: "Odontólogo", languageCode: "es" },
          pureServiceAreaBusiness: false,
        },
        { id: "ChIJb", displayName: { text: "Sonrisas a domicilio" } },
      ],
    }),
  );
  const [first, second] = await searchText(
    { textQuery: "Clínica Sonrisas", mask: "target" },
    spend,
  );
  expect(first).toMatchObject({
    addressComponents,
    location: { latitude: 4.81, longitude: -75.69 },
    primaryTypeDisplayName: "Dentista",
    googleMapsTypeLabel: "Odontólogo",
    pureServiceAreaBusiness: false,
  });
  expect(second).toMatchObject({
    addressComponents: [],
    primaryTypeDisplayName: null,
    googleMapsTypeLabel: null,
    pureServiceAreaBusiness: false,
  });
  expect(second).not.toHaveProperty("location");
});

test("a search without matches returns no hits", async () => {
  capture(SEARCH_URL);
  await expect(searchText({ textQuery: "zzzz", mask: "resolve" }, spend)).resolves.toEqual([]);
});

test("details masks are the IDs-only and the two Enterprise ones", async () => {
  const seen = capture(DETAILS_URL, () =>
    HttpResponse.json({
      id: "ChIJa",
      movedPlaceId: "ChIJmoved",
      websiteUri: "https://sonrisas.co/",
      regularOpeningHours: { weekdayDescriptions: ["lunes: 8:00–18:00"] },
    }),
  );
  await placeDetails("ChIJa", "idsOnly", spend);
  await placeDetails("ChIJa", "website", spend);
  await placeDetails("ChIJa", "findings", spend);
  expect(
    seen.map((r) => [r.method, new URL(r.url).pathname, r.headers["x-goog-fieldmask"]]),
  ).toEqual([
    ["GET", "/v1/places/ChIJa", "id,movedPlaceId"],
    ["GET", "/v1/places/ChIJa", "websiteUri"],
    ["GET", "/v1/places/ChIJa", "regularOpeningHours,websiteUri"],
  ]);
  expect(seen.every((r) => r.headers["x-goog-api-key"] === API_KEY)).toBe(true);
});

test("details return only the fields of their mask and keep the asked id", async () => {
  capture(DETAILS_URL, () => HttpResponse.json({ id: "ChIJa", movedPlaceId: "ChIJmoved" }));
  await expect(placeDetails("ChIJa", "idsOnly", spend)).resolves.toEqual({
    id: "ChIJa",
    movedPlaceId: "ChIJmoved",
  });
  // Enterprise masks do not ask for the id, so the response has none.
  capture(DETAILS_URL, () => HttpResponse.json({ websiteUri: "https://sonrisas.co/" }));
  await expect(placeDetails("ChIJa", "website", spend)).resolves.toEqual({
    id: "ChIJa",
    websiteUri: "https://sonrisas.co/",
  });
  const hours = { periods: [{ open: { day: 1, hour: 8, minute: 0 } }] };
  capture(DETAILS_URL, () => HttpResponse.json({ regularOpeningHours: hours }));
  await expect(placeDetails("ChIJa", "findings", spend)).resolves.toEqual({
    id: "ChIJa",
    regularOpeningHours: hours,
  });
});

test("a place id is sent as one path segment", async () => {
  const seen = capture("https://places.googleapis.com/v1/places/*", () =>
    HttpResponse.json({ id: "a/b" }),
  );
  await placeDetails("a/b", "idsOnly", spend);
  expect(new URL(seen[0]?.url ?? "").pathname).toBe("/v1/places/a%2Fb");
});

function googleError(status: number, code: string, headers?: Record<string, string>) {
  return () =>
    HttpResponse.json(
      { error: { code: status, message: "secret detail from the body", status: code } },
      { status, ...(headers && { headers }) },
    );
}

test("a 404 detail returns null; 429 → RateLimited; 5xx → ProviderUnavailable", async () => {
  capture(DETAILS_URL, googleError(404, "NOT_FOUND"));
  await expect(placeDetails("ChIJgone", "idsOnly", spend)).resolves.toBeNull();

  capture(SEARCH_URL, googleError(429, "RESOURCE_EXHAUSTED", { "Retry-After": "7" }));
  const limited = searchText({ textQuery: "a", mask: "resolve" }, spend);
  await expect(limited).rejects.toBeInstanceOf(RateLimitedError);
  await expect(limited).rejects.toMatchObject({ retryAfterMs: 7000 });

  capture(SEARCH_URL, googleError(503, "UNAVAILABLE"));
  await expect(searchText({ textQuery: "a", mask: "resolve" }, spend)).rejects.toBeInstanceOf(
    ProviderUnavailableError,
  );

  capture(DETAILS_URL, googleError(500, "INTERNAL"));
  await expect(placeDetails("ChIJa", "website", spend)).rejects.toBeInstanceOf(
    ProviderUnavailableError,
  );
});

test("any other refusal is ProviderRejected with Google's status and none of the body", async () => {
  capture(SEARCH_URL, googleError(400, "INVALID_ARGUMENT"));
  const rejected = searchText({ textQuery: "a", mask: "resolve" }, spend);
  await expect(rejected).rejects.toBeInstanceOf(ProviderRejectedError);
  await expect(rejected).rejects.toMatchObject({ providerCode: "INVALID_ARGUMENT" });
  await expect(rejected).rejects.not.toThrow(/secret detail/);

  capture(SEARCH_URL, () => new HttpResponse("<html>Forbidden</html>", { status: 403 }));
  await expect(searchText({ textQuery: "a", mask: "resolve" }, spend)).rejects.toMatchObject({
    providerCode: "http_403",
  });
});

test("a request lost in flight is ProviderUnavailable", async () => {
  capture(SEARCH_URL, () => HttpResponse.error());
  await expect(searchText({ textQuery: "a", mask: "resolve" }, spend)).rejects.toBeInstanceOf(
    ProviderUnavailableError,
  );
});

test("a success without the asked id is an error that leaves the body out", async () => {
  capture(SEARCH_URL, () => HttpResponse.json({ places: [{ displayName: { text: "Sin id" } }] }));
  const failed = searchText({ textQuery: "a", mask: "resolve" }, spend);
  await expect(failed).rejects.toThrow(/Places/);
  await expect(failed).rejects.not.toThrow(/Sin id/);
});

test("each call settles the price of its SKU", async () => {
  capture(SEARCH_URL, () => HttpResponse.json({ places: [{ id: "ChIJa" }] }));
  capture(DETAILS_URL, () => HttpResponse.json({ id: "ChIJa" }));

  await searchText({ textQuery: "a", mask: "resolve" }, spend);
  expect(jobs.reserveSpend).toHaveBeenLastCalledWith({
    provider: "google_places",
    estimate: cost(32_000, "USD"),
    ...spend,
  });
  expect(jobs.settleSpend).toHaveBeenLastCalledWith(
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
    expect(jobs.reserveSpend).toHaveBeenCalledWith(
      expect.objectContaining({ estimate: cost(20_000, "USD") }),
    );
    expect(jobs.settleSpend).toHaveBeenCalledWith(expect.anything(), cost(20_000, "USD"));
  }
});

test("every call takes a Places slot and gives it back, even when it fails", async () => {
  capture(SEARCH_URL, googleError(503, "UNAVAILABLE"));
  await expect(searchText({ textQuery: "a", mask: "resolve" }, spend)).rejects.toThrow();
  expect(jobs.acquireProviderSlot).toHaveBeenCalledWith(
    "google_places",
    expect.objectContaining({ maxInFlight: expect.any(Number) }),
  );
  expect(jobs.release).toHaveBeenCalledOnce();
});

test("a refused request gives the reservation back; one lost in flight keeps it", async () => {
  capture(SEARCH_URL, googleError(400, "INVALID_ARGUMENT"));
  await expect(searchText({ textQuery: "a", mask: "resolve" }, spend)).rejects.toThrow();
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
    await searchText({ textQuery: "a", mask: "resolve" }, spend).catch(() => {});
    return jobs.breakerRecord.mock.calls.map(([, outcome]) => outcome);
  };
  expect(await outcomes(() => HttpResponse.json({}))).toEqual(["success"]);
  expect(await outcomes(googleError(400, "INVALID_ARGUMENT"))).toEqual(["success"]);
  expect(await outcomes(googleError(429, "RESOURCE_EXHAUSTED"))).toEqual(["success"]);
  expect(await outcomes(googleError(502, "UNAVAILABLE"))).toEqual(["failure"]);
  expect(await outcomes(() => HttpResponse.error())).toEqual(["failure"]);
});

test("a spend denial stops the call before it reaches Google", async () => {
  const seen = capture(SEARCH_URL);
  jobs.reserveSpend.mockRejectedValueOnce(new Error("cap"));
  await expect(searchText({ textQuery: "a", mask: "resolve" }, spend)).rejects.toThrow("cap");
  expect(seen).toHaveLength(0);
  expect(jobs.release).toHaveBeenCalledOnce();
});
