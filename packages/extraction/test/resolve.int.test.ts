import { createHash, randomBytes, randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import type { SpendContext } from "@reranker/jobs";
import { cost } from "@reranker/schema";
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
import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { currentExtractorConfig } from "../src/config";
import { nameHmac, normalizeName } from "../src/normalize";
import { readDecisions } from "../src/places/cache";
import { resolveReportMentions } from "../src/resolve";
import { insertExtraction } from "../src/store";

vi.mock("@reranker/flags", () => ({ isEnabled: async () => true }));

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const RUN = randomUUID();
const TARGET_PLACE = `ChIJ_target_${RUN}`;
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");

let searches = 0;
beforeAll(() => {
  vi.stubEnv("APP_ENV", process.env.APP_ENV ?? "development");
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "places-integration-key");
  // A key of this run only, so no other run's cached decisions answer for these names.
  vi.stubEnv("ENTITY_NAME_HMAC_KEY", randomBytes(32).toString("base64url"));
  server.listen();
  server.use(
    http.post(SEARCH_URL, async ({ request }) => {
      searches += 1;
      const { textQuery } = (await request.json()) as { textQuery: string };
      const name = textQuery.replace(/ Medellín$/, "").replace(/^Dra\. /, "");
      return HttpResponse.json({
        places: [
          {
            id: name === "Sonrisas Dental" ? TARGET_PLACE : `ChIJ_${RUN}_${name}`,
            displayName: { text: name, languageCode: "es" },
            formattedAddress: "Cra. 43A #1-50, Medellín, Antioquia, Colombia",
            types: ["dental_clinic", "health"],
            primaryType: "dental_clinic",
            businessStatus: "OPERATIONAL",
          },
        ],
      });
    }),
  );
});
afterAll(async () => {
  server.close();
  vi.unstubAllEnvs();
  await endPools();
});

const MEDELLIN: GeoTarget = {
  key: "co-c1000815",
  level: "city",
  country: "CO",
  name: "Medellín",
  regionName: "Antioquia",
  center: { lat: 6.2442, lng: -75.5812 },
  dataforseo: { locationCode: 1000815, level: "city", label: "Medellin,Antioquia,Colombia" },
  enrichment: null,
  geoDataHash: "0".repeat(64),
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
const target: TargetBusiness = {
  placeId: TARGET_PLACE,
  domain: null,
  inputName: "Sonrisas Dental",
  geo: MEDELLIN,
  category: DENTAL,
  aliases: [],
};
const spend: SpendContext = { purpose: "contract-test", refType: "resolve-int", refId: RUN };

async function storedExtraction(): Promise<string> {
  const id = `cap_${randomBytes(13).toString("hex").toUpperCase()}`;
  await withSystem("extraction.test", async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(
      sql`insert into public_panel.measurement_plans (purpose, ref_type, ref_id, digest, slot_count)
          values ('contract-test', 'probe', ${randomUUID()}, ${Buffer.from(hex(id), "hex")}, 1)
          returning id`,
    );
    await tx.execute(
      sql`insert into public_panel.captures (id, measurement_id, slot_index, attempt, intent_set_id,
            intent_id, engine, channel, provider, mode, status, response_bytes, latency_ms,
            cost_amount_micros, cost_currency, envelope_sha256)
          values (${id}, ${rows[0]?.id}, 0, 1, 'is_0123456789abcdef',
            'odontologia.blanqueamiento-dental', 'chatgpt', 'ui-vendor', 'dataforseo', 'live',
            'succeeded', 1024, 900, 4000, 'USD', ${Buffer.from(hex(`envelope:${id}`), "hex")})`,
    );
  });
  await insertExtraction({
    captureId: id,
    configHash: currentExtractorConfig.configHash,
    outputsSha256: hex(`outputs:${id}`),
    answerKind: "names_entities",
    agreement: "agreed",
    judgeUsed: false,
    inputTokens: 1830,
    outputTokens: 412,
    cost: cost(1712, "USD"),
    latencyMs: 4210,
    disputedCount: 0,
  });
  return id;
}

let offset = 0;
function mention(name: string, stance: Stance, kind: EntityKind = "business"): ExtractedMention {
  offset += 50;
  return {
    name,
    nameNorm: normalizeName(name, kind),
    quote: name,
    startOffset: offset,
    endOffset: offset + name.length,
    ordinal: stance === "recommendation" && kind !== "platform" ? 1 : null,
    stance,
    entityKind: kind,
    sentiment: "positive",
    locationHint: null,
    citedUrls: kind === "platform" ? ["https://www.doctoralia.co/"] : [],
  };
}

const asExtraction = (captureId: string, mentions: ExtractedMention[]): ResponseExtraction => ({
  captureId,
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
  cost: cost(1712, "USD"),
  latencyMs: 4210,
});

type StoredMention = {
  entity_key: string;
  stance: Stance;
  name_norm: string | null;
  is_target: boolean;
  resolution_status: string;
};

async function storedMentions(captureId: string): Promise<StoredMention[]> {
  const { rows } = await withSystem("extraction.test", (tx) =>
    tx.execute<StoredMention>(
      sql`select m.entity_key, m.stance, m.name_norm, m.is_target, m.resolution_status
            from public_panel.mentions m
            join public_panel.extractions e on e.id = m.extraction_id
           where e.capture_id = ${captureId}
           order by m.start_offset`,
    ),
  );
  return rows;
}

test("stores the used mentions and the decisions; a second run searches nothing and adds no row", async () => {
  const captureId = await storedExtraction();
  const input = {
    extractions: [
      asExtraction(captureId, [
        mention("Clínica Aurora", "recommendation"),
        mention("Clínica Aurora", "incidental"),
        mention("Dra. Ana Gómez", "recommendation", "professional"),
        mention("Doctoralia", "incidental", "platform"),
        mention("Sonrisas Dental", "incidental"),
      ]),
    ],
    geo: MEDELLIN,
    category: DENTAL,
    target,
    spend,
  };

  const first = await resolveReportMentions(input);
  expect(searches).toBe(3);
  const rows = await storedMentions(captureId);
  expect(rows).toEqual([
    {
      entity_key: `place:ChIJ_${RUN}_Clínica Aurora`,
      stance: "recommendation",
      name_norm: "clinica aurora",
      is_target: false,
      resolution_status: "resolved",
    },
    {
      entity_key: `place:ChIJ_${RUN}_Ana Gómez`,
      stance: "recommendation",
      name_norm: null,
      is_target: false,
      resolution_status: "resolved",
    },
    {
      entity_key: `place:${TARGET_PLACE}`,
      stance: "incidental",
      name_norm: "sonrisas dental",
      is_target: true,
      resolution_status: "resolved",
    },
  ]);

  const keys = ["clinica aurora", "ana gomez", "sonrisas dental"].map((name) => ({
    nameHmac: nameHmac(name),
    geoKey: MEDELLIN.key,
    categoryKey: DENTAL.key,
  }));
  const cached = await readDecisions(keys, currentExtractorConfig.configHash);
  expect(cached.size).toBe(3);

  const second = await resolveReportMentions(input);
  expect(searches).toBe(3);
  expect(await storedMentions(captureId)).toHaveLength(3);
  expect(second[0]?.mentions.map((m) => m.entityKey)).toEqual(
    first[0]?.mentions.map((m) => m.entityKey),
  );
  expect(second[0]?.mentions[0]?.resolution.method).toBe("cache");
});
