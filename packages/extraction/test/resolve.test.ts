import { RateLimitedError, type SpendContext, type SpendReservation } from "@reranker/jobs";
import type {
  BusinessCategory,
  EntityKind,
  ExtractedMention,
  GeoTarget,
  ResponseExtraction,
  Stance,
  TargetBusiness,
} from "@reranker/schema/measurement";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { currentExtractorConfig } from "../src/config";
import { nameHmac, normalizeName } from "../src/normalize";
import type { CachedDecision } from "../src/places/cache";
import type { StructuredResult } from "../src/providers/types";
import { entityKeyOf, matchesTarget, resolveReportMentions } from "../src/resolve";
import type { ResolveJudgeOutput } from "../src/schema";
import type { MentionRow } from "../src/store";

const doubles = vi.hoisted(() => ({
  flagOn: true,
  cache: new Map<string, unknown>(),
  written: [] as unknown[],
  stored: [] as unknown[],
  judge: vi.fn(),
}));

vi.mock("@reranker/flags", () => ({ isEnabled: async () => doubles.flagOn }));
vi.mock("../src/providers/openai", () => ({ callOpenAI: doubles.judge }));
vi.mock("../src/places/cache", () => ({
  readDecisions: vi.fn(async (keys: Array<Record<string, string>>) => {
    const found = new Map();
    for (const k of keys) {
      const key = `${k.nameHmac}|${k.geoKey}|${k.categoryKey}`;
      if (doubles.cache.has(key)) found.set(key, doubles.cache.get(key));
    }
    return found;
  }),
  writeDecisions: vi.fn(async (rows: unknown[]) => {
    doubles.written.push(...rows);
  }),
}));
vi.mock("../src/store", () => ({
  extractionIdsOf: vi.fn(
    async (captureIds: string[]) => new Map(captureIds.map((id) => [id, `ext-${id}`])),
  ),
  insertMentions: vi.fn(async (rows: unknown[]) => {
    doubles.stored.push(...rows);
    return rows.length;
  }),
}));

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

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const spend: SpendContext = {
  purpose: "free-report",
  pool: "free-report-anonymous",
  country: "CO",
  refType: "free_report",
  refId: "r1",
};

const MEDELLIN: GeoTarget = {
  key: "co-c1000815",
  level: "city",
  country: "CO",
  name: "Medellín",
  regionName: "Antioquia",
  center: { lat: 6.2442, lng: -75.5812, level: "city", label: "Medellín" },
  dataforseo: { locationCode: 1000815, level: "city", label: "Medellin,Antioquia,Colombia" },
  enrichment: null,
  geoDataHash: "0".repeat(64),
};
const ANTIOQUIA: GeoTarget = {
  ...MEDELLIN,
  key: "co-r20040",
  level: "region",
  name: "Antioquia",
  center: { lat: 6.2442, lng: -75.5812, level: "region", label: "Antioquia" },
};
const DENTAL: BusinessCategory = {
  key: "dental_clinic",
  source: "seed",
  label: "Clínicas dentales",
  noun: "clínica dental",
  archetype: "health",
  scope: "local",
  register: "usted",
  placesTypes: ["dental_clinic", "dentist"],
};
const HOTEL: BusinessCategory = {
  ...DENTAL,
  key: "hotel",
  archetype: "lodging",
  placesTypes: ["hotel", "lodging"],
};
const ONLINE: BusinessCategory = {
  ...DENTAL,
  key: "online_store",
  archetype: "online_national",
  scope: "national",
  placesTypes: [],
};

const TARGET_PLACE = "ChIJ_target";
const target = (overrides: Partial<TargetBusiness> = {}): TargetBusiness => ({
  placeId: TARGET_PLACE,
  domain: null,
  inputName: "Sonrisas Dental",
  geo: MEDELLIN,
  category: DENTAL,
  aliases: [],
  ...overrides,
});

let offset = 0;
function mention(
  name: string,
  opts: {
    stance?: Stance;
    kind?: EntityKind;
    hint?: string | null;
    cited?: string[];
  } = {},
): ExtractedMention {
  const kind = opts.kind ?? "business";
  const stance = opts.stance ?? "recommendation";
  offset += 100;
  return {
    name,
    nameNorm: normalizeName(name, kind),
    quote: name,
    startOffset: offset,
    endOffset: offset + name.length,
    ordinal: stance === "recommendation" ? 1 : null,
    stance,
    entityKind: kind,
    sentiment: "positive",
    locationHint: opts.hint ?? null,
    citedUrls: opts.cited ?? [],
  };
}

let captures = 0;
function extraction(...mentions: ExtractedMention[]): ResponseExtraction {
  captures += 1;
  return {
    captureId: `cap_${captures}`,
    configHash: currentExtractorConfig.configHash,
    answerKind: "names_entities",
    agreement: "agreed",
    mentions: mentions.map((m) => ({
      ...m,
      entityKey: `name:${m.nameNorm}`,
      placeId: null,
      resolution: { status: "not_attempted", method: "none", score: null },
      isTarget: false,
    })),
    models: { primary: "gpt-6-luna", secondary: "gemini-3.1-flash-lite", judge: null },
    cost: { amount_micros: 0, currency: "USD" },
    latencyMs: 1,
  };
}

const run = (
  extractions: ResponseExtraction[],
  t: TargetBusiness = target(),
  over: { geo?: GeoTarget; category?: BusinessCategory } = {},
) =>
  resolveReportMentions({
    extractions,
    geo: over.geo ?? t.geo,
    category: over.category ?? t.category,
    target: t,
    spend,
  });

type PlaceJson = Record<string, unknown>;
const placeJson = (
  id: string,
  name: string,
  over: { types?: string[]; address?: string; status?: string } = {},
): PlaceJson => ({
  id,
  displayName: { text: name, languageCode: "es" },
  formattedAddress: over.address ?? "Cra. 43A #1-50, Medellín, Antioquia, Colombia",
  types: over.types ?? ["dental_clinic", "health"],
  primaryType: (over.types ?? ["dental_clinic"])[0],
  businessStatus: over.status ?? "OPERATIONAL",
});

let searches: Array<Record<string, unknown>> = [];
let details: Array<{ id: string; mask: string | null }> = [];
/** Answers each search with the exact listing named in the query unless `answers` says otherwise. */
function places(
  answers: Record<string, PlaceJson[] | number> = {},
  websites: Record<string, string> = {},
) {
  server.use(
    http.post(SEARCH_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      searches.push(body);
      const query = body.textQuery as string;
      const name = query.replace(/ Medellín$| Antioquia$/, "");
      const answer = answers[name];
      if (typeof answer === "number") {
        return HttpResponse.json({ error: { status: "RESOURCE_EXHAUSTED" } }, { status: answer });
      }
      return HttpResponse.json({ places: answer ?? [placeJson(`pl-${name}`, name)] });
    }),
    http.get("https://places.googleapis.com/v1/places/:id", ({ params, request }) => {
      const id = params.id as string;
      details.push({ id, mask: request.headers.get("x-goog-fieldmask") });
      return HttpResponse.json(websites[id] ? { websiteUri: websites[id] } : {});
    }),
  );
}

const judgeAnswers = (choice: ResolveJudgeOutput["choice"]) =>
  doubles.judge.mockImplementation(
    async (): Promise<StructuredResult<ResolveJudgeOutput>> => ({
      output: { choice },
      modelReported: "gpt-6-luna-2026-10-01",
      usage: { inputTokens: 600, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 40 },
      raw: {},
    }),
  );

const all = (rs: ResponseExtraction[]) => rs.flatMap((r) => r.mentions);
const byName = (rs: ResponseExtraction[], name: string) =>
  all(rs).find((m) => m.name === name) ?? expect.fail(`no mention ${name}`);

beforeAll(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "places-unit-key");
  vi.stubEnv("OPENAI_API_KEY", "sk-unit");
  vi.stubEnv("ENTITY_NAME_HMAC_KEY", Buffer.alloc(32, 7).toString("base64url"));
  server.listen();
});
beforeEach(() => {
  searches = [];
  doubles.judge.mockReset();
  judgeAnswers("candidate_1");
  details = [];
  doubles.flagOn = true;
  doubles.cache.clear();
  doubles.written = [];
  doubles.stored = [];
  jobs.acquireProviderSlot.mockResolvedValue({ release: async () => {} });
  jobs.reserveSpend.mockImplementation(
    async (req: { estimate: SpendReservation["reserved"] }) =>
      ({ id: "res-1", reserved: req.estimate }) as SpendReservation,
  );
  places();
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});

const COMPETITORS = [
  "Aurora",
  "Brisa",
  "Ceiba",
  "Delta",
  "Esmeralda",
  "Faro",
  "Galena",
  "Horizonte",
  "Iris",
  "Jade",
  "Kora",
  "Lumen",
  "Magnolia",
  "Nube",
];

test("selects the target-like clusters and the top 10 by recommendations only", async () => {
  // Entity i is recommended i + 1 times, so the four least recommended are left out.
  const extractions = COMPETITORS.map((name, i) =>
    extraction(...Array.from({ length: i + 1 }, () => mention(name))),
  );
  extractions.push(extraction(mention("Sonrisa Dental", { stance: "incidental" })));
  const r = await run(extractions);

  expect(searches.map((s) => s.textQuery)).toHaveLength(11);
  expect(searches.map((s) => s.textQuery)).toContain("Sonrisa Dental Medellín");
  for (const name of COMPETITORS.slice(0, 4)) {
    expect(byName(r, name)).toMatchObject({
      entityKey: `name:${normalizeName(name, "business")}@${MEDELLIN.key}`,
      resolution: { status: "not_attempted", method: "none", score: null },
    });
  }
  expect(byName(r, "Nube")).toMatchObject({
    entityKey: "place:pl-Nube",
    placeId: "pl-Nube",
    resolution: { status: "resolved", method: "rules" },
  });
  // Only the recommendations of selected entities and every target mention are stored.
  const stored = doubles.stored as MentionRow[];
  expect(stored.every((row) => row.resolutionStatus === "resolved")).toBe(true);
  expect(stored).toHaveLength(5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14);
});

test("cluster names by JW ≥ 0.92 so variants resolve once and share a key", async () => {
  const r = await run([
    extraction(mention("Clínica Sonrisas")),
    extraction(mention("Clinica Sonrisa")),
  ]);
  expect(searches).toHaveLength(1);
  const [a, b] = all(r);
  expect(a?.entityKey).toBe(b?.entityKey);
  expect(doubles.written).toHaveLength(1);
});

test("entity keys follow the spec forms", () => {
  const m = mention("Cruz Verde");
  const place: CachedDecision = {
    outcome: "place",
    placeId: "ChIJ1",
    score: 0.95,
    method: "rules",
  };
  const chain: CachedDecision = { outcome: "chain", score: 0.95, method: "rules" };
  expect(entityKeyOf(m, place, MEDELLIN, "local")).toBe("place:ChIJ1");
  expect(entityKeyOf(m, chain, MEDELLIN, "local")).toBe(`chain:cruz verde@${MEDELLIN.key}`);
  expect(entityKeyOf(m, null, MEDELLIN, "national")).toBe("name:cruz verde@co");
  const professional = mention("Dra. Ana Gómez", { kind: "professional" });
  expect(entityKeyOf(professional, null, MEDELLIN, "local")).toBe(
    `name:${nameHmac("ana gomez")}@${MEDELLIN.key}`,
  );
  expect(entityKeyOf(professional, chain, MEDELLIN, "local")).not.toContain("ana");
  const booking = mention("Booking.com", { kind: "platform" });
  expect(entityKeyOf(booking, null, MEDELLIN, "local")).toBe("platform:booking");
});

test("a mention resolved to the target place is the target", async () => {
  places({ "Sonrisas Dental": [placeJson(TARGET_PLACE, "Sonrisas Dental")] });
  const r = await run([extraction(mention("Sonrisas Dental", { stance: "incidental" }))]);
  expect(all(r)[0]).toMatchObject({
    entityKey: `place:${TARGET_PLACE}`,
    isTarget: true,
    resolution: { status: "resolved" },
  });
  expect(doubles.stored).toHaveLength(1);
});

test("a homonym resolved to another place is not the target", async () => {
  places({ "Sonrisas Dental": [placeJson("ChIJ_other", "Sonrisas Dental")] });
  const r = await run([extraction(mention("Sonrisas Dental"))]);
  expect(all(r)[0]).toMatchObject({ placeId: "ChIJ_other", isTarget: false });
});

test("a web target matches by cited domain and takes the web key", async () => {
  const web = target({ placeId: null, domain: "sonrisasdental.co", inputName: "Sonrisas" });
  const r = await run(
    [
      extraction(
        mention("Tienda de blanqueamiento", { cited: ["https://www.sonrisasdental.co/kits"] }),
        mention("Booking", { kind: "platform", cited: ["https://sonrisasdental.co/"] }),
      ),
    ],
    web,
  );
  expect(all(r)[0]).toMatchObject({
    entityKey: "web:sonrisasdental.co",
    placeId: null,
    isTarget: true,
  });
  expect(all(r)[1]).toMatchObject({ entityKey: "platform:booking", isTarget: false });
});

test("matchesTarget compares names and aliases, not platforms", () => {
  const t = target({ aliases: ["Odontología Sonrisas S.A.S."] });
  expect(matchesTarget(mention("Sonrisas Dental"), t)).toBe(true);
  expect(matchesTarget(mention("Odontologia Sonrisas"), t)).toBe(true);
  expect(matchesTarget(mention("Sonrisas Kids"), t)).toBe(false);
  expect(matchesTarget(mention("Doctoralia", { kind: "platform" }), t)).toBe(false);
});

test("places-resolution off keeps name keys and finds the target by alias", async () => {
  doubles.flagOn = false;
  const t = target({ aliases: ["Clínica Sonrisas Dental"] });
  const r = await run([extraction(mention("Clinica Sonrisas Dental"), mention("Aurora"))], t);
  expect(searches).toHaveLength(0);
  expect(all(r)[0]).toMatchObject({
    entityKey: `name:clinica sonrisas dental@${MEDELLIN.key}`,
    isTarget: true,
    resolution: { status: "not_attempted" },
  });
  expect(all(r)[1]?.isTarget).toBe(false);
  expect(doubles.stored).toHaveLength(2);
});

test("a cached decision is used without searching", async () => {
  const key = `${nameHmac("aurora")}|${MEDELLIN.key}|${DENTAL.key}`;
  doubles.cache.set(key, {
    outcome: "place",
    placeId: "ChIJ_aurora",
    score: 0.97,
    method: "rules",
  });
  const r = await run([extraction(mention("Aurora"))]);
  expect(searches).toHaveLength(0);
  expect(all(r)[0]).toMatchObject({
    entityKey: "place:ChIJ_aurora",
    resolution: { status: "resolved", method: "cache", score: 0.97 },
  });
  expect(doubles.written).toHaveLength(0);
});

test("locationBias follows the target geo level and national scope has none", async () => {
  await run([extraction(mention("Aurora"))]);
  expect(searches[0]).toEqual({
    textQuery: "Aurora Medellín",
    regionCode: "co",
    includedType: "dental_clinic",
    locationBias: { circle: { center: { latitude: 6.2442, longitude: -75.5812 }, radius: 20_000 } },
    languageCode: "es",
    pageSize: 5,
  });

  await run([extraction(mention("Brisa"))], target({ geo: ANTIOQUIA }));
  type Corner = { latitude: number; longitude: number };
  type Box = { low: Corner; high: Corner };
  const { rectangle: box } = (searches[1] ?? expect.fail("no search")).locationBias as {
    rectangle: Box;
  };
  // 80 km each way: Places caps a bias circle at 50 km, so a region gets a box instead.
  expect(box.high.latitude - 6.2442).toBeCloseTo(80 / 111.32, 3);
  expect(6.2442 - box.low.latitude).toBeCloseTo(80 / 111.32, 3);
  expect(box.high.longitude - -75.5812).toBeCloseTo(
    80 / (111.32 * Math.cos((6.2442 * Math.PI) / 180)),
    3,
  );

  await run([extraction(mention("Ceiba"))], target({ category: ONLINE }));
  expect(searches[2]).toEqual({
    textQuery: "Ceiba",
    regionCode: "co",
    languageCode: "es",
    pageSize: 5,
  });

  places({ Delta: [placeJson("pl-Delta", "Delta", { types: ["hotel"] })] });
  await run([extraction(mention("Delta"))], target({ category: HOTEL }));
  expect(searches[3]).not.toHaveProperty("includedType");
});

test("several same-name branches without a location hint are a chain", async () => {
  places({
    "Cruz Verde": [
      placeJson("cv1", "Cruz Verde", { types: ["pharmacy"] }),
      placeJson("cv2", "Cruz Verde", { types: ["pharmacy"] }),
    ],
  });
  const r = await run([extraction(mention("Cruz Verde"))]);
  expect(all(r)[0]).toMatchObject({
    entityKey: `chain:cruz verde@${MEDELLIN.key}`,
    placeId: null,
    resolution: { status: "chain", method: "rules" },
  });
  expect(doubles.written).toEqual([
    expect.objectContaining({
      decision: expect.objectContaining({ outcome: "chain", method: "rules" }),
    }),
  ]);
});

const TWO_BRANCHES = [
  placeJson("poblado", "Clínica Sonrisa", { address: "Cl. 10, El Poblado, Medellín" }),
  placeJson("laureles", "Clínica Sonrisa", {
    address: "Cra. 70, Laureles, Medellín",
    types: ["doctor"],
  }),
];

test("close candidates with a cited site fetch both websites before deciding", async () => {
  places({ "Clínica Sonrisa": TWO_BRANCHES }, { laureles: "https://www.sonrisa.co/" });
  const r = await run([
    extraction(
      mention("Clínica Sonrisa", { hint: "Laureles", cited: ["https://sonrisa.co/citas"] }),
    ),
  ]);
  expect(details.map((d) => d.mask)).toEqual(["websiteUri", "websiteUri"]);
  expect(all(r)[0]).toMatchObject({
    placeId: "laureles",
    resolution: { status: "resolved", method: "rules", score: 1 },
  });
});

test("the gray zone goes to the resolution judge with the top 3", async () => {
  places({ "Clínica Sonrisa": TWO_BRANCHES });
  judgeAnswers("candidate_2");
  const r = await run([extraction(mention("Clínica Sonrisa", { hint: "Laureles" }))]);
  expect(doubles.judge).toHaveBeenCalledOnce();
  const call = doubles.judge.mock.calls[0]?.[0] as { user: string; schemaName: string };
  const sent = JSON.parse(call.user);
  expect(sent.candidates.map((c: { name: string }) => c.name)).toEqual([
    "Clínica Sonrisa",
    "Clínica Sonrisa",
  ]);
  expect(all(r)[0]).toMatchObject({
    placeId: "laureles",
    resolution: { status: "resolved", method: "judge", score: 0.9 },
  });
});

test("the judge may leave a mention unresolvable", async () => {
  places({ "Clínica Sonrisa": TWO_BRANCHES });
  judgeAnswers("unresolvable");
  const r = await run([extraction(mention("Clínica Sonrisa", { hint: "Laureles" }))]);
  expect(all(r)[0]).toMatchObject({
    entityKey: `name:clinica sonrisa@${MEDELLIN.key}`,
    resolution: { status: "unresolvable", method: "judge" },
  });
});

test("a rate-limited judge fails the resolution instead of degrading it", async () => {
  places({ "Clínica Sonrisa": TWO_BRANCHES });
  doubles.judge.mockRejectedValue(new RateLimitedError(1000, "OpenAI"));
  await expect(
    run([
      extraction(mention("Clínica Sonrisa", { hint: "Laureles" })),
      extraction(mention("Aurora")),
    ]),
  ).rejects.toBeInstanceOf(RateLimitedError);
  // The decision another cluster already paid for is kept.
  expect(doubles.written).toEqual([
    expect.objectContaining({ decision: expect.objectContaining({ placeId: "pl-Aurora" }) }),
  ]);
});

test("Places quota exhausted mid-report keeps name keys for the rest and marks them not_attempted", async () => {
  const answers: Record<string, number> = {};
  for (const name of COMPETITORS.slice(3, 10)) answers[name] = 429;
  places(answers);
  const r = await run(COMPETITORS.slice(0, 10).map((name) => extraction(mention(name))));
  const statuses = COMPETITORS.slice(0, 10).map((name) => byName(r, name).resolution.status);
  expect(statuses.filter((s) => s === "resolved")).toHaveLength(3);
  expect(statuses.filter((s) => s === "not_attempted")).toHaveLength(7);
  expect(byName(r, "Jade").entityKey).toBe(`name:jade@${MEDELLIN.key}`);
});

test("professional names are stored only as their hmac", async () => {
  await run([extraction(mention("Dra. Ana Gómez", { kind: "professional" }))]);
  const [row] = doubles.stored as MentionRow[];
  expect(row).toMatchObject({ nameNorm: null, nameHmac: nameHmac("ana gomez") });
});

test("a professional resolves by rules to a titled listing without calling the judge", async () => {
  places({
    "Ana Gómez": [
      placeJson("ana", "Dra. Ana Gómez - Odontóloga"),
      placeJson("sonrisas", "Clínica Dental Sonrisas"),
    ],
  });
  const r = await run([extraction(mention("Ana Gómez", { kind: "professional" }))]);
  expect(doubles.judge).not.toHaveBeenCalled();
  expect(all(r)[0]).toMatchObject({
    entityKey: "place:ana",
    resolution: { status: "resolved", method: "rules" },
  });
});

test("a professional listing with another surname still goes to the judge", async () => {
  places({
    "Dra. Ana Gómez": [
      placeJson("ana-pena", "Dra. Ana Gómez Peña - Odontóloga"),
      placeJson("sonrisas", "Clínica Dental Sonrisas"),
    ],
  });
  await run([extraction(mention("Dra. Ana Gómez", { kind: "professional" }))]);
  expect(doubles.judge).toHaveBeenCalledOnce();
});

test("a titled professional target matches its untitled mentions", () => {
  const t = target({ inputName: "Dra. Ana Gómez - Odontóloga" });
  expect(matchesTarget(mention("Ana Gómez", { kind: "professional" }), t)).toBe(true);
  expect(matchesTarget(mention("Doctora Ana Gómez", { kind: "professional" }), t)).toBe(true);
  expect(matchesTarget(mention("Dr. Andrés Gómez", { kind: "professional" }), t)).toBe(false);
});
