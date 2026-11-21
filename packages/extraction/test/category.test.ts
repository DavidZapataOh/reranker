import { getGeo } from "@reranker/catalog";
import { SpendCapExceededError, type SpendContext, type SpendReservation } from "@reranker/jobs";
import type { BusinessCandidate } from "@reranker/schema/measurement";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { categoryByRules, inferCategory } from "../src/category";
import type { StructuredCall, StructuredResult } from "../src/providers/types";
import type { ClassifierOutput } from "../src/schema";

const doubles = vi.hoisted(() => ({ classify: vi.fn() }));
vi.mock("../src/providers/openai", () => ({ callOpenAI: doubles.classify }));

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

const spend: SpendContext = {
  purpose: "free-report",
  pool: "free-report-anonymous",
  country: "CO",
  refType: "free_report",
  refId: "r1",
};
const opts = { spend };

function place(
  over: Partial<NonNullable<BusinessCandidate["places"]>> & { country?: string } = {},
): BusinessCandidate {
  const { country = "co", ...places } = over;
  const primaryType = places.primaryType ?? null;
  return {
    kind: "place",
    placeId: "ChIJ-test",
    domain: null,
    displayName: "La Espiga",
    formattedAddress: null,
    geo: getGeo(country),
    neighborhood: null,
    categoryHint: null,
    confidence: 0.95,
    attribution: "Google Maps",
    places: {
      types: primaryType ? [primaryType, "point_of_interest", "establishment"] : [],
      primaryType,
      primaryTypeDisplayName: null,
      googleMapsTypeLabel: null,
      pureServiceAreaBusiness: false,
      ...places,
    },
  };
}

function website(
  page: { title?: string; description?: string },
  country: string | null = "co",
): BusinessCandidate {
  return {
    kind: "website",
    placeId: null,
    domain: "tienda-ejemplo.com",
    displayName: page.title ?? "tienda-ejemplo.com",
    formattedAddress: null,
    geo: country === null ? null : getGeo(country),
    neighborhood: null,
    categoryHint: null,
    confidence: 1,
    attribution: null,
    website: { title: page.title ?? null, siteName: null, description: page.description ?? null },
  };
}

const CAFE: ClassifierOutput = {
  categoryKey: "cafe-de-origen",
  label: "Café de origen",
  noun: "café de origen",
  nounGender: null,
  archetype: "online_national",
  scope: "national",
  confidence: 0.9,
};

const classifierSays = (output: ClassifierOutput) =>
  doubles.classify.mockImplementation(
    async (): Promise<StructuredResult<ClassifierOutput>> => ({
      output,
      modelReported: "gpt-6-luna-2026-10-01",
      usage: { inputTokens: 700, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 60 },
      raw: {},
    }),
  );
const lastPayload = () => {
  const call = doubles.classify.mock.lastCall?.[0] as StructuredCall<ClassifierOutput>;
  return JSON.parse(call.user) as Record<string, unknown>;
};

beforeAll(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("OPENAI_API_KEY", "sk-unit");
});
beforeEach(() => {
  classifierSays(CAFE);
  jobs.acquireProviderSlot.mockResolvedValue({ release: async () => {} });
  jobs.reserveSpend.mockImplementation(
    async (req: { estimate: SpendReservation["reserved"] }) =>
      ({ id: "res-1", reserved: req.estimate }) as SpendReservation,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
afterAll(() => vi.unstubAllEnvs());

describe("categoryByRules", () => {
  test("a seed type maps to its seed category with high confidence", () =>
    expect(categoryByRules(place({ primaryType: "dental_clinic" }))).toMatchObject({
      key: "dental_clinic",
      source: "seed",
      confidence: 0.95,
      label: "Clínica odontológica",
      noun: "clínica odontológica",
      scope: "local",
      register: "tu",
      placesTypes: ["dental_clinic", "dentist"],
      language: "es",
      nounGender: null,
    }));

  test("a Table A type outside the seed becomes gen:places:<type> labelled by Google", () =>
    expect(
      categoryByRules(place({ primaryType: "bakery", primaryTypeDisplayName: "Panadería" })),
    ).toMatchObject({
      key: "gen:places:bakery",
      source: "places_type",
      label: "Panadería",
      noun: "panadería",
      archetype: "food",
      scope: "local",
      placesTypes: ["bakery"],
    }));

  test("without Google's label the catalog's Spanish label names the type", () =>
    expect(categoryByRules(place({ primaryType: "bakery" }))).toMatchObject({
      label: "Panadería",
      noun: "panadería",
    }));

  test.each(["store", "point_of_interest", "establishment"])(
    "generic type %s needs the classifier",
    (t) => expect(categoryByRules(place({ primaryType: t, types: [t] }))).toBeNull(),
  );

  test("a specific type after a generic primary type still decides", () =>
    expect(
      categoryByRules(place({ primaryType: "store", types: ["store", "dentist"] })),
    ).toMatchObject({ key: "dental_clinic", source: "seed" }));

  test("a website has no Places type to go by", () =>
    expect(categoryByRules(website({ title: "Café de origen" }))).toBeNull());

  // The reviewed seed names its categories in every language from that language's searches.
  test.each([
    ["us", "en", "dentist", null],
    ["br", "pt", "dentista", "m"],
    ["fr", "fr", "dentiste", "m"],
    ["de", "de", "Zahnarzt", "m"],
    ["it", "it", "dentista", "m"],
  ] as const)("in %s a seed type is named in %s with its gender", (country, language, noun, g) =>
    expect(categoryByRules(place({ primaryType: "dentist", country }))).toMatchObject({
      key: "dental_clinic",
      noun,
      language,
      nounGender: g,
    }),
  );

  // Google's type labels come in Spanish; outside Spanish the classifier names the business.
  test.each(["us", "br", "fr", "de", "it"])("in %s a Table A type goes to the classifier", (c) =>
    expect(
      categoryByRules(
        place({ primaryType: "bakery", primaryTypeDisplayName: "Panadería", country: c }),
      ),
    ).toBeNull(),
  );

  test("an explicit language overrides the country's", () =>
    expect(categoryByRules(place({ primaryType: "dentist", country: "co" }), "en")).toMatchObject({
      noun: "dentist",
      language: "en",
    }));

  // Such a business is refused when its questions are built; until then it is named in Spanish.
  test("a country without a measured language names the seed in Spanish", () =>
    expect(categoryByRules(place({ primaryType: "dentist", country: "jp" }))).toMatchObject({
      noun: "clínica odontológica",
      language: "es",
    }));
});

describe("inferCategory", () => {
  test("rules answer without a paid call", async () => {
    await expect(inferCategory(place({ primaryType: "dentist" }), opts)).resolves.toMatchObject({
      key: "dental_clinic",
    });
    expect(doubles.classify).not.toHaveBeenCalled();
  });

  test("website candidates go to the classifier and are national", async () => {
    const c = await inferCategory(
      website({ title: "Café de origen con envíos a todo Colombia" }),
      opts,
    );
    expect(c).toMatchObject({
      key: "gen:cafe-de-origen",
      label: "Café de origen",
      noun: "café de origen",
      scope: "national",
      source: "inferred",
      confidence: 0.9,
      register: "tu",
    });
    expect(lastPayload()).toMatchObject({
      language: "es",
      country: "CO",
      website: { title: "Café de origen con envíos a todo Colombia" },
    });
    expect(jobs.reserveSpend).toHaveBeenCalledWith(
      expect.objectContaining({ ...spend, provider: "openai" }),
    );
  });

  test("a website whose business needs premises is measured as an online business", async () => {
    classifierSays({ ...CAFE, categoryKey: "telemedicina", archetype: "health", scope: "local" });
    await expect(inferCategory(website({ title: "Telemedicina" }), opts)).resolves.toMatchObject({
      archetype: "online_national",
      scope: "national",
    });
  });

  test("classifier national only with confidence ≥ 0.8", async () => {
    const store = place({ primaryType: "store", types: ["store"] });
    classifierSays({ ...CAFE, archetype: "local_retail", scope: "national", confidence: 0.79 });
    await expect(inferCategory(store, opts)).resolves.toMatchObject({ scope: "local" });
    classifierSays({ ...CAFE, archetype: "local_retail", scope: "national", confidence: 0.8 });
    await expect(inferCategory(store, opts)).resolves.toMatchObject({ scope: "national" });
  });

  test("a place whose archetype is only local stays local", async () => {
    classifierSays({ ...CAFE, archetype: "health", scope: "national", confidence: 0.95 });
    await expect(
      inferCategory(place({ primaryType: "store", types: ["store"] }), opts),
    ).resolves.toMatchObject({ scope: "local", archetype: "health" });
  });

  test("a seed key from the classifier takes the seed's reviewed names", async () => {
    classifierSays({
      ...CAFE,
      categoryKey: "hotel",
      noun: "hospedaje",
      archetype: "lodging",
      scope: "local",
    });
    await expect(inferCategory(website({ title: "Hotel" }), opts)).resolves.toMatchObject({
      key: "hotel",
      source: "seed",
      noun: "hotel",
    });
  });

  test("an online store keeps the product the classifier named", async () => {
    classifierSays({ ...CAFE, categoryKey: "online_store", noun: "café de origen" });
    await expect(inferCategory(website({ title: "Café" }), opts)).resolves.toMatchObject({
      key: "online_store",
      noun: "café de origen",
      scope: "national",
    });
  });

  test("a key with accents is folded to ASCII", async () => {
    classifierSays({ ...CAFE, categoryKey: "Café-de-Origen" });
    await expect(inferCategory(website({ title: "Café" }), opts)).resolves.toMatchObject({
      key: "gen:cafe-de-origen",
    });
  });

  test("classifier archetype outside the table is rejected and rules fall back", async () => {
    // The provider adapter parses with the schema; an unknown archetype never comes back as output.
    doubles.classify.mockRejectedValue(new Error("archetype 'space' is not in the enum"));
    await expect(
      inferCategory(
        place({ primaryType: "store", types: ["store"], googleMapsTypeLabel: "Tienda" }),
        opts,
      ),
    ).resolves.toMatchObject({
      key: "gen:places:store",
      archetype: "local_retail",
      label: "Tienda",
      noun: "tienda",
      scope: "local",
      confidence: 0.5,
    });
  });

  test("an unusable key falls back", async () => {
    classifierSays({ ...CAFE, categoryKey: "x" });
    await expect(inferCategory(website({ title: "Café" }), opts)).resolves.toMatchObject({
      key: "online_store",
      confidence: 0.5,
    });
  });

  test("a spend cap falls back instead of throwing", async () => {
    jobs.reserveSpend.mockRejectedValue(new SpendCapExceededError("free-report", new Date()));
    await expect(inferCategory(website({ title: "Café" }), opts)).resolves.toMatchObject({
      key: "online_store",
      label: "Tienda online",
      noun: "tienda online",
      archetype: "online_national",
      scope: "national",
      confidence: 0.5,
    });
  });

  test("classifier down → rules or Places archetype with local scope in ≤ 3.5 s", async () => {
    vi.useFakeTimers();
    doubles.classify.mockImplementation(() => new Promise(() => {}));
    const p = inferCategory(place({ primaryType: "store", googleMapsTypeLabel: "Tienda" }), opts);
    await vi.advanceTimersByTimeAsync(3500);
    await expect(p).resolves.toMatchObject({ scope: "local" });
  });

  test("the call is billed and settled even when it comes back after the fallback", async () => {
    vi.useFakeTimers();
    jobs.acquireProviderSlot.mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ release: async () => {} }), 2900)),
    );
    const answered = doubles.classify.getMockImplementation() as () => Promise<unknown>;
    doubles.classify.mockImplementation(
      () => new Promise((r) => setTimeout(() => r(answered()), 500)),
    );
    const p = inferCategory(website({ title: "Café" }), opts);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toMatchObject({ confidence: 0.5 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(jobs.settleSpend).toHaveBeenCalledTimes(1);
    expect(jobs.releaseSpend).not.toHaveBeenCalled();
  });
});

describe("inferCategory in every measurement language", () => {
  // What the classifier names is kept as written in the business's language, never translated.
  test.each([
    [
      "co",
      "es",
      { categoryKey: "panaderia", label: "Panadería", noun: "panadería", nounGender: null },
    ],
    ["us", "en", { categoryKey: "bakery", label: "Bakery", noun: "bakery", nounGender: null }],
    ["br", "pt", { categoryKey: "padaria", label: "Padaria", noun: "padaria", nounGender: "f" }],
    [
      "fr",
      "fr",
      { categoryKey: "boulangerie", label: "Boulangerie", noun: "boulangerie", nounGender: "f" },
    ],
    [
      "de",
      "de",
      { categoryKey: "baeckerei", label: "Bäckerei", noun: "Bäckerei", nounGender: "f" },
    ],
    [
      "it",
      "it",
      { categoryKey: "panetteria", label: "Panetteria", noun: "panetteria", nounGender: "f" },
    ],
  ] as const)("in %s the classifier names a bakery in %s", async (country, language, names) => {
    classifierSays({ ...CAFE, ...names, archetype: "food", scope: "local" });
    const c = await inferCategory(place({ primaryType: "store", types: ["store"], country }), opts);
    expect(lastPayload()).toMatchObject({ language, country: country.toUpperCase() });
    expect(c).toMatchObject({
      key: `gen:${names.categoryKey}`,
      label: names.label,
      noun: names.noun,
      nounGender: names.nounGender,
      language,
      scope: "local",
    });
  });

  // Those businesses are refused when their questions are built; the category only needs a name.
  test.each([
    ["a country without a measured language", "jp"],
    ["no known country", null],
  ])("with %s the classifier is asked in Spanish", async (_, country) => {
    await inferCategory(website({ title: "x" }, country), opts);
    expect(lastPayload()).toMatchObject({
      language: "es",
      country: country?.toUpperCase() ?? null,
    });
  });

  test("the language the caller measures in wins over the country's", async () => {
    classifierSays({ ...CAFE, label: "Bakery", noun: "bakery", categoryKey: "bakery" });
    await inferCategory(place({ primaryType: "store", types: ["store"], country: "co" }), {
      ...opts,
      language: "en",
    });
    expect(lastPayload()).toMatchObject({ language: "en" });
  });

  test.each([
    ["fr", null],
    ["pt", "n"],
  ] as const)("a %s noun with gender %s is unusable and falls back", async (country, gender) => {
    const at = country === "fr" ? "fr" : "br";
    classifierSays({ ...CAFE, noun: "boulangerie", nounGender: gender });
    await expect(inferCategory(website({ title: "x" }, at), opts)).resolves.toMatchObject({
      key: "online_store",
      confidence: 0.5,
    });
  });

  test("a gender is dropped where templates do not agree with the noun", async () => {
    classifierSays({ ...CAFE, nounGender: "f" });
    await expect(inferCategory(website({ title: "x" }), opts)).resolves.toMatchObject({
      nounGender: null,
    });
  });

  test.each([
    ["us", "en", "Online store", "online store"],
    ["br", "pt", "Loja online", "loja online"],
    ["fr", "fr", "Boutique en ligne", "boutique en ligne"],
    ["de", "de", "Onlineshop", "Onlineshop"],
    ["it", "it", "Negozio online", "negozio online"],
  ])(
    "in %s a website falls back to the seed's %s online store",
    async (country, language, label, noun) => {
      doubles.classify.mockRejectedValue(new Error("down"));
      await expect(inferCategory(website({ title: "x" }, country), opts)).resolves.toMatchObject({
        key: "online_store",
        language,
        label,
        noun,
        scope: "national",
      });
    },
  );

  test("outside Spanish the Places fallback is named by Google's English type", async () => {
    doubles.classify.mockRejectedValue(new Error("down"));
    await expect(
      inferCategory(place({ primaryType: "hair_salon", country: "us" }), opts),
    ).resolves.toMatchObject({
      key: "gen:places:hair_salon",
      label: "Hair salon",
      noun: "hair salon",
    });
  });
});
