import { withSystem } from "@reranker/db";
import { places } from "@reranker/db/schema";
import { ProviderRejectedError, type SpendContext } from "@reranker/jobs";
import type { ResolutionMethod } from "@reranker/schema/measurement";
import { type SQL, sql } from "drizzle-orm";
import { placeDetails } from "./client";

export type CachedDecision =
  | { outcome: "place"; placeId: string; score: number; method: ResolutionMethod }
  | { outcome: "chain" | "unresolvable"; score: number | null; method: ResolutionMethod };

/** Hex HMAC of the normalized name, plus the geo and category the decision was made for. */
export type DecisionKey = { nameHmac: string; geoKey: string; categoryKey: string };

const REASON = "extraction.places_cache";
// A business that Places could not match may open or be listed later; a match only moves, and
// the daily refresh follows it.
const UNRESOLVABLE_TTL = sql.raw("interval '30 days'");
const STALE_AFTER = sql.raw("interval '90 days'");
// Lanes for the refresh, so it never holds every Places slot the live reports need.
const REFRESH_LANES = 4;

const bytes = (hex: string) => Buffer.from(hex, "hex");
// Drizzle expands a bare array into a list; a param binds it as one array value.
const array = (values: unknown[]) => sql.param(values);
const keyOf = (k: DecisionKey) => `${k.nameHmac}|${k.geoKey}|${k.categoryKey}`;

/** The statement behind `readDecisions`; exported so its plan can be checked. */
export function readDecisionsQuery(keys: DecisionKey[], configHash: string): SQL {
  return sql`
    select p.name_hmac, p.geo_key, p.category_key, p.outcome, p.place_id, p.score, p.method
      from unnest(${array(keys.map((k) => bytes(k.nameHmac)))}::bytea[],
                  ${array(keys.map((k) => k.geoKey))}::text[],
                  ${array(keys.map((k) => k.categoryKey))}::text[]) as k(name_hmac, geo_key, category_key)
      join ${places} p
        on p.name_hmac = k.name_hmac and p.geo_key = k.geo_key and p.category_key = k.category_key
     where p.config_hash = ${bytes(configHash)}
       and (p.outcome <> 'unresolvable' or p.decided_at > now() - ${UNRESOLVABLE_TTL})`;
}

type DecisionRow = {
  name_hmac: Buffer;
  geo_key: string;
  category_key: string;
  outcome: CachedDecision["outcome"];
  place_id: string | null;
  score: number | null;
  method: ResolutionMethod;
};

function toDecision(row: DecisionRow): CachedDecision {
  if (row.outcome === "place") {
    // The table's check guarantees a place id and the writer a score for every place.
    return {
      outcome: "place",
      placeId: row.place_id as string,
      score: row.score as number,
      method: row.method,
    };
  }
  return { outcome: row.outcome, score: row.score, method: row.method };
}

/** Every cached decision for the keys in one query, keyed `${nameHmac}|${geoKey}|${categoryKey}`. */
export async function readDecisions(
  keys: DecisionKey[],
  configHash: string,
): Promise<Map<string, CachedDecision>> {
  if (keys.length === 0) return new Map();
  const { rows } = await withSystem(REASON, (tx) =>
    tx.execute<DecisionRow>(readDecisionsQuery(keys, configHash)),
  );
  return new Map(
    rows.map((row) => [
      keyOf({
        nameHmac: row.name_hmac.toString("hex"),
        geoKey: row.geo_key,
        categoryKey: row.category_key,
      }),
      toDecision(row),
    ]),
  );
}

/** Stores the decisions in one upsert; a newer decision for a key replaces the older one. */
export async function writeDecisions(
  rows: Array<DecisionKey & { decision: CachedDecision }>,
  configHash: string,
): Promise<void> {
  // One statement cannot update the same row twice, so the last decision per key wins here.
  const unique = [...new Map(rows.map((row) => [keyOf(row), row])).values()];
  if (unique.length === 0) return;
  await withSystem(REASON, (tx) =>
    tx
      .insert(places)
      .values(
        unique.map(({ nameHmac, geoKey, categoryKey, decision }) => ({
          nameHmac: bytes(nameHmac),
          geoKey,
          categoryKey,
          configHash: bytes(configHash),
          outcome: decision.outcome,
          placeId: decision.outcome === "place" ? decision.placeId : null,
          score: decision.score,
          method: decision.method,
        })),
      )
      .onConflictDoUpdate({
        target: [places.nameHmac, places.geoKey, places.categoryKey, places.configHash],
        set: {
          outcome: sql`excluded.outcome`,
          placeId: sql`excluded.place_id`,
          score: sql`excluded.score`,
          method: sql`excluded.method`,
          decidedAt: sql`now()`,
          validatedAt: sql`now()`,
        },
      }),
  );
}

type StaleRow = {
  name_hmac: Buffer;
  geo_key: string;
  category_key: string;
  config_hash: Buffer;
  place_id: string;
};

type Refreshed = { current: string } | { gone: true };

// Google answers NOT_FOUND for an obsolete id and INVALID_ARGUMENT for one it no longer accepts
// (https://developers.google.com/maps/documentation/places/web-service/place-id).
async function refreshed(placeId: string, spend: SpendContext): Promise<Refreshed> {
  try {
    const details = await placeDetails(placeId, "idsOnly", spend);
    return details ? { current: details.movedPlaceId ?? details.id } : { gone: true };
  } catch (error) {
    if (error instanceof ProviderRejectedError && error.providerCode === "INVALID_ARGUMENT") {
      return { gone: true };
    }
    throw error;
  }
}

async function eachInLanes<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(REFRESH_LANES, items.length) }, lane));
}

/**
 * Re-checks the place ids validated longest ago with the free IDs Only SKU: a moved place takes
 * its new id and an obsolete one is dropped, so the next report resolves it again. Counts are of
 * distinct place ids.
 */
export async function refreshStalePlaceIds(
  limit: number,
  spend: SpendContext,
): Promise<{ checked: number; moved: number; gone: number }> {
  const { rows } = await withSystem(REASON, (tx) =>
    tx.execute<StaleRow>(sql`
      select name_hmac, geo_key, category_key, config_hash, place_id from ${places}
       where outcome = 'place' and validated_at < now() - ${STALE_AFTER}
       order by validated_at
       limit ${limit}`),
  );
  const ids = [...new Set(rows.map((row) => row.place_id))];
  const outcomes = new Map<string, Refreshed>();
  await eachInLanes(ids, async (id) => {
    outcomes.set(id, await refreshed(id, spend));
  });

  const kept: StaleRow[] = [];
  const current: string[] = [];
  const dropped: StaleRow[] = [];
  for (const row of rows) {
    const outcome = outcomes.get(row.place_id) as Refreshed;
    if ("gone" in outcome) dropped.push(row);
    else {
      kept.push(row);
      current.push(outcome.current);
    }
  }
  const column = <K extends keyof StaleRow>(list: StaleRow[], name: K) =>
    array(list.map((row) => row[name]));
  // Each row changes only if it still holds the id that was checked: a decision written
  // meanwhile is newer than this refresh.
  await withSystem(REASON, async (tx) => {
    if (kept.length > 0) {
      await tx.execute(sql`
        update ${places} p set place_id = r.current, validated_at = now()
          from unnest(${column(kept, "name_hmac")}::bytea[], ${column(kept, "geo_key")}::text[],
                      ${column(kept, "category_key")}::text[], ${column(kept, "config_hash")}::bytea[],
                      ${column(kept, "place_id")}::text[], ${array(current)}::text[])
               as r(name_hmac, geo_key, category_key, config_hash, checked, current)
         where (p.name_hmac, p.geo_key, p.category_key, p.config_hash)
             = (r.name_hmac, r.geo_key, r.category_key, r.config_hash)
           and p.place_id = r.checked`);
    }
    if (dropped.length > 0) {
      await tx.execute(sql`
        delete from ${places} p
         using unnest(${column(dropped, "name_hmac")}::bytea[], ${column(dropped, "geo_key")}::text[],
                      ${column(dropped, "category_key")}::text[], ${column(dropped, "config_hash")}::bytea[],
                      ${column(dropped, "place_id")}::text[])
               as r(name_hmac, geo_key, category_key, config_hash, checked)
         where (p.name_hmac, p.geo_key, p.category_key, p.config_hash)
             = (r.name_hmac, r.geo_key, r.category_key, r.config_hash)
           and p.place_id = r.checked`);
    }
  });

  let moved = 0;
  let gone = 0;
  for (const [id, outcome] of outcomes) {
    if ("gone" in outcome) gone++;
    else if (outcome.current !== id) moved++;
  }
  return { checked: ids.length, moved, gone };
}
