import { getGeo, jcs } from "@reranker/catalog";
import { withSystem } from "@reranker/db";
import { captures, intentSets } from "@reranker/db/schema";
import { type CapturePredicateInput, sealCapture } from "@reranker/evidence";
import { getCountry } from "@reranker/i18n/countries";
import { InvalidInputError } from "@reranker/jobs/errors";
import type { EngineId } from "@reranker/schema";
import { inArray } from "drizzle-orm";
import { adapterFor, type CaptureRecord } from "./adapters";
import type { EngineAnswer } from "./answer";
import { ENGINES } from "./engines";
import { loadPlan } from "./measurement";

// The product surface each engine answers on, as the signed statement names it.
const SURFACES: Record<EngineId, string> = {
  chatgpt: "chatgpt-web",
  gemini: "gemini-web",
  "google-ai-overview": "google-search-ai-overview",
  "google-ai-mode": "google-search-ai-mode",
  perplexity: "perplexity-web",
};

type IntentSetRef = { version: string; merkleRoot: string };

// A set id is derived from the set's content, so what it names never changes.
const intentSetCache = new Map<string, IntentSetRef>();

/** Version and Merkle root of each intent set, which every capture statement names. */
export async function loadIntentSets(ids: readonly string[]): Promise<Map<string, IntentSetRef>> {
  const missing = [...new Set(ids)].filter((id) => !intentSetCache.has(id));
  if (missing.length > 0) {
    const rows = await withSystem("capture", (tx) =>
      tx
        .select({
          setId: intentSets.setId,
          version: intentSets.version,
          merkleRoot: intentSets.merkleRoot,
        })
        .from(intentSets)
        .where(inArray(intentSets.setId, missing)),
    );
    for (const row of rows) {
      intentSetCache.set(row.setId, {
        version: row.version,
        merkleRoot: row.merkleRoot.toString("hex"),
      });
    }
  }
  return new Map(
    ids.map((id) => {
      const ref = intentSetCache.get(id);
      if (!ref) throw new InvalidInputError(`Intent set ${id} is not registered`);
      return [id, ref];
    }),
  );
}

/** A field of the task as it was sent, so the statement declares what the provider received. */
function sent(request: Uint8Array, key: string): unknown {
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(request));
    const task = Array.isArray(body) ? body[0] : body;
    return task !== null && typeof task === "object"
      ? (task as Record<string, unknown>)[key]
      : null;
  } catch {
    return null;
  }
}

function declaredGeo(record: CaptureRecord): CapturePredicateInput["geo"]["declared"] {
  const { slot } = record;
  const target = getGeo(slot.geoKey);
  const { level } = slot.geoDeclared;
  const locationCode = sent(record.request, "location_code");
  return {
    country: target.country,
    region:
      level === "country" ? null : target.level === "region" ? target.name : target.regionName,
    city: level === "city" ? target.name : null,
    vendor_location_code: typeof locationCode === "number" ? locationCode : null,
  };
}

const versionOf = (answer: EngineAnswer) => Number(answer.parserVersion.split("@")[1]);

/**
 * Seals a capture and stores its row in one transaction, so no row exists without its signed
 * evidence. Persisting the same capture again stores nothing new.
 */
export async function persistCapture(
  record: CaptureRecord,
  opts: { attempt: number; late: boolean },
): Promise<{ captureId: string; stored: boolean }> {
  const { slot, answer } = record;
  const plan = await loadPlan(slot.measurementId);
  const set = (await loadIntentSets([slot.intentSetId])).get(slot.intentSetId);
  if (!set) throw new InvalidInputError(`Intent set ${slot.intentSetId} is not registered`);
  const { channel } = adapterFor(slot.provider);
  const parserVersion = answer ? versionOf(answer) : null;
  const forceWebSearch = sent(record.request, "force_web_search");
  const predicate: CapturePredicateInput = {
    plan: {
      digest: { sha256: plan.planEnvelopeSha256 },
      slot: slot.slotIndex,
      attempt: opts.attempt,
    },
    prompt: {
      set_version: set.version,
      set_root: set.merkleRoot,
      intent_id: slot.intentId,
      paraphrase_id: slot.paraphraseId,
      persona_id: slot.personaId ?? null,
      lang: getCountry(getGeo(slot.geoKey).country).defaultLocale,
      text: slot.promptText,
    },
    engine: {
      name: slot.engine,
      surface: SURFACES[slot.engine],
      channel,
      vendor: slot.provider,
      vendor_task_id: record.providerTaskId,
      endpoint: record.endpoint,
      model_reported: record.modelReported,
      mode: record.mode,
      tool_version: null,
      fan_out_queries: Array.isArray(answer?.searchQueries) ? answer.searchQueries : null,
    },
    params: {
      force_web_search: typeof forceWebSearch === "boolean" ? forceWebSearch : null,
      temperature: null,
    },
    geo: { declared: declaredGeo(record), egress: null },
    session: { state: "anonymous", fresh: true },
    provider_signature: null,
    tlsn: null,
    c2pa: null,
  };
  // Without a reported cost the reservation is what the ledger keeps, so the row says the same.
  const charged = record.cost ?? ENGINES[slot.engine].estimate.live;

  return withSystem("capture", async (tx) => {
    const sealed = await sealCapture(
      {
        captureId: record.captureId,
        responseBytes: record.response,
        responseContentType: record.responseContentType,
        requestBytes: record.request,
        normalized: answer && parserVersion !== null ? { json: jcs(answer), parserVersion } : null,
        predicate,
      },
      { tx },
    );
    // No target: a retried capture conflicts on its id, a second success for the slot on
    // captures_one_success, and neither may store another row.
    const [inserted] = await tx
      .insert(captures)
      .values({
        id: record.captureId,
        measurementId: slot.measurementId,
        slotIndex: slot.slotIndex,
        attempt: opts.attempt,
        intentSetId: slot.intentSetId,
        intentId: slot.intentId,
        engine: slot.engine,
        channel,
        provider: slot.provider,
        mode: record.mode,
        status: record.status,
        providerStatusCode: record.providerStatusCode,
        httpStatus: record.httpStatus,
        modelReported: record.modelReported,
        responseBytes: record.response.length,
        parserVersion,
        latencyMs: record.latencyMs,
        cost_amount_micros: charged.amount_micros,
        cost_currency: charged.currency,
        late: opts.late,
        envelopeSha256: Buffer.from(sealed.envelopeSha256, "hex"),
        normalizedSha256:
          sealed.normalizedSha256 === null ? null : Buffer.from(sealed.normalizedSha256, "hex"),
      })
      .onConflictDoNothing()
      .returning({ id: captures.id });
    return { captureId: record.captureId, stored: inserted !== undefined };
  });
}
