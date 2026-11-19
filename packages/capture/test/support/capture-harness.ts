import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { geoForEngine, getGeo } from "@reranker/catalog";
import { endPools, withSystem } from "@reranker/db";
import { captures, intentSets } from "@reranker/db/schema";
import type { EngineId } from "@reranker/schema";
import type { PlannedSlot } from "@reranker/schema/measurement";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { loadSigner } from "../../../evidence/src/signer";
import { previewEnv } from "../../../evidence/test/support/evidence-env";
import { localSigner } from "../../../evidence/test/support/local-signer";
import { createMeasurement, freezeMeasurementPlan, resetPlanCache } from "../../src/measurement";
import type { SlotId } from "../../src/slot";

// Test files mock "../../evidence/src/signer" and the jobs `enqueue` before importing this harness:
// signing keys live in KMS and the log integration runs as a job.

export const fixture = (path: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/${path}`, import.meta.url)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** R2 as an in-memory bucket (the evidence contract tests exercise the real one). */
export const r2 = new Map<string, Uint8Array<ArrayBuffer>>();

/** DataForSEO, answering every engine with real recorded bytes unless `next` says otherwise. */
export const provider = {
  calls: [] as EngineId[],
  served: [] as Uint8Array[],
  next: [] as Uint8Array[],
  inFlight: 0,
  maxInFlight: 0,
  delayMs: 0,
  r2RefusesWrites: false,
};

async function fakeR2(request: Request): Promise<Response> {
  const key = new URL(request.url).pathname.split("/").slice(2).join("/");
  if (request.method === "PUT") {
    if (provider.r2RefusesWrites) return new Response(null, { status: 503 });
    r2.set(key, new Uint8Array(gunzipSync(new Uint8Array(await request.arrayBuffer()))));
    return new Response(null, { status: 200 });
  }
  const body = r2.get(key);
  return body ? new Response(body, { status: 200 }) : new Response(null, { status: 404 });
}

const ANSWERS: Array<[RegExp, EngineId, Uint8Array]> = [
  [/gemini\/llm_scraper\/live/, "gemini", fixture("recorded/live/gemini-dentistas-medellin.json")],
  [
    /google\/organic\/live/,
    "google-ai-overview",
    // Its references come wrapped in google.com/goto redirects.
    fixture("recorded/live/ai-overview-pico-y-placa-medellin.json"),
  ],
  [
    /google\/ai_mode\/live/,
    "google-ai-mode",
    fixture("recorded/live/ai-mode-dentistas-medellin.json"),
  ],
];

async function fakeDataForSeo(request: Request): Promise<Response> {
  const match = ANSWERS.find(([path]) => path.test(request.url));
  if (!match) return new Response(null, { status: 404 });
  provider.calls.push(match[1]);
  provider.inFlight += 1;
  provider.maxInFlight = Math.max(provider.maxInFlight, provider.inFlight);
  try {
    await sleep(provider.delayMs + Math.random() * 10);
    const body = provider.next.shift() ?? match[2];
    provider.served.push(body);
    return new Response(body, { headers: { "content-type": "application/json" } });
  } finally {
    provider.inFlight -= 1;
  }
}

/** Where every Google redirect leads; the site itself is never contacted. */
export const SITE = "https://clinica.example/";
const GOOGLE_REDIRECT_HOSTS = new Set([
  "google.com",
  "www.google.com",
  "vertexaisearch.cloud.google.com",
]);

function route(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const { hostname } = new URL(request.url);
  if (hostname === "sandbox.dataforseo.com") return fakeDataForSeo(request);
  if (hostname.endsWith(".r2.cloudflarestorage.com")) return fakeR2(request);
  if (GOOGLE_REDIRECT_HOSTS.has(hostname)) {
    return Promise.resolve(new Response(null, { status: 302, headers: { location: SITE } }));
  }
  return Promise.resolve(new Response(null, { status: 404 }));
}

const MEDELLIN = "co-c1003654";
export const INTENT_SET = "is_c0ffee0123456789";
export const MERKLE_ROOT = createHash("sha256").update("capture-test-set").digest("hex");

export function plannedSlots(engines: EngineId[]): PlannedSlot[] {
  return engines.map((engine, i) => {
    const geoDeclared = geoForEngine(engine, getGeo(MEDELLIN), "local", { provider: "dataforseo" });
    if (!geoDeclared) throw new Error(`${engine} is not offered in ${MEDELLIN}`);
    return {
      engine,
      provider: "dataforseo",
      intentSetId: INTENT_SET,
      intentId: `dental_clinic.intent-${i % 4}` as PlannedSlot["intentId"],
      paraphraseId: `p${i}`,
      geoKey: MEDELLIN,
      geoDeclared,
      runIndex: 0,
      promptText: "¿Cuál es el mejor odontólogo en Medellín?",
    };
  });
}

/** A frozen contract-test measurement of one slot per engine given. */
export async function frozen(engines: EngineId[]): Promise<{ m: string; ids: SlotId[] }> {
  const { measurementId } = await createMeasurement({
    purpose: "contract-test",
    refType: "capture-test",
    refId: randomUUID(),
  });
  const { slotIds } = await freezeMeasurementPlan(measurementId, plannedSlots(engines));
  return { m: measurementId, ids: slotIds };
}

export const rowsOf = (m: string) =>
  withSystem("capture.test", (tx) =>
    tx.select().from(captures).where(eq(captures.measurementId, m)).orderBy(captures.attempt),
  );

/** Spend ledger rows of a measurement's calls, counted by status. */
export async function ledger(m: string): Promise<Record<string, number>> {
  const { rows } = await withSystem("capture.test", (tx) =>
    tx.execute<{ status: string; n: number }>(
      sql`select status, count(*)::int as n from ops.spend_ledger
          where ref_type = 'capture-test' and ref_id = ${m} group by status`,
    ),
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

export const envelopeCount = () =>
  Array.from(r2.keys()).filter((k) => k.startsWith("envelopes/")).length;

export function artifactJson(kind: string, sha256: Buffer | null) {
  return JSON.parse(new TextDecoder().decode(r2.get(`${kind}/${sha256?.toString("hex")}`)));
}

export function statementOf(envelopeSha256: Buffer) {
  const envelope = artifactJson("envelopes", envelopeSha256);
  return JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
}

export function installCaptureHarness(): void {
  const signer = localSigner("rr-capture-preview-1-ed25519");
  beforeAll(async () => {
    process.env.DB_POOL_MAX = "12";
    // Three reports of 200 calls reserve 2.40 USD, past the nightly contract-test cap.
    process.env.SPEND_CAP_DAILY_CONTRACT_TEST_USD = "10";
    await withSystem("capture.test", (tx) =>
      tx
        .insert(intentSets)
        .values({
          kind: "seed",
          scope: "local",
          registerProfile: "co",
          generators: 0,
          variantCount: 4,
          setId: INTENT_SET,
          version: "capture-test@1",
          categoryKey: "dental_clinic",
          contentHash: createHash("sha256").update(INTENT_SET).digest(),
          merkleRoot: Buffer.from(MERKLE_ROOT, "hex"),
        })
        .onConflictDoNothing(),
    );
  });
  afterAll(() => endPools());

  beforeEach(() => {
    // Each test spends on a day of its own, so no other run's counters or caps meet it.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.UTC(2100 + Math.floor(Math.random() * 800), 0, 1, 17)));
    for (const [name, value] of Object.entries(previewEnv)) vi.stubEnv(name, value);
    vi.stubEnv("VERCEL_REGION", "iad1");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "fedcba9876543210fedcba9876543210fedcba98");
    vi.stubEnv("DATAFORSEO_LOGIN", "capture-test");
    vi.stubEnv("DATAFORSEO_PASSWORD", "capture-test-password");
    vi.stubGlobal("fetch", vi.fn(route));
    vi.mocked(loadSigner).mockResolvedValue(signer);
    r2.clear();
    Object.assign(provider, {
      calls: [],
      served: [],
      next: [],
      inFlight: 0,
      maxInFlight: 0,
      delayMs: 0,
      r2RefusesWrites: false,
    });
    resetPlanCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
}
