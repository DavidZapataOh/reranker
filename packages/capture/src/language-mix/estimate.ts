import { createHash } from "node:crypto";
import {
  type LanguageMix,
  type LanguageMixDegraded,
  placeLanguage,
  secondLanguageOf,
  unmeasuredMix,
} from "@reranker/catalog";
import { withSystem } from "@reranker/db";
import { languageMixClaims, languageMixes } from "@reranker/db/schema";
import { SpendCapExceededError } from "@reranker/jobs";
import type { GeoTarget, MeasurementLanguage } from "@reranker/schema/measurement";
import { log } from "@reranker/telemetry";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import {
  FETCH_MAX_MS,
  type FetchContext,
  fetchLanguageVolumes,
  type LanguageVolumes,
} from "./fetch";
import { type CategoryTerms, sharesOf } from "./keywords";

export type { CategoryTerms } from "./keywords";

export interface EstimateLanguageMixInput {
  geo: GeoTarget;
  categoryKey: string;
  terms: CategoryTerms;
  /** The caller's cut: past it the main language is returned alone and the fetch goes on. */
  deadlineAt: number;
}

export type EstimateOptions = Pick<FetchContext, "base">;

const REASON = "capture.language-mix";
// Bumped when the keywords or the shares are computed differently, so old rows are refetched.
const METHOD = 1;
const REUSE_DAYS = 30;
const REUSE_MS = REUSE_DAYS * 86_400_000;
const POLL_MS = 250;
const CACHE_SIZE = 512;
// The holder's claim outlives the longest fetch by the time storing the row can take.
const CLAIM_MS = FETCH_MAX_MS + 10_000;

type Row = typeof languageMixes.$inferSelect;

const cache = new Map<string, LanguageMix>();

/** Drops the mixes this instance holds, as a fresh instance starts. */
export function forgetLanguageMixes(): void {
  cache.clear();
}

function remember(key: string, mix: LanguageMix): LanguageMix {
  cache.delete(key);
  cache.set(key, mix);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return mix;
}

function configHash(terms: CategoryTerms): Buffer {
  const sorted = Object.entries(terms)
    .filter(([, list]) => list && list.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(JSON.stringify({ method: METHOD, terms: sorted }))
    .digest();
}

function mixOf(row: Row, main: MeasurementLanguage): LanguageMix {
  const shares = row.shares as LanguageMix["shares"];
  return {
    shares,
    level: row.level,
    source: row.source,
    asOf: row.fetchedAt.toISOString().slice(0, 10),
    second: secondLanguageOf(shares, main),
    degraded: null,
  };
}

const findRow = (geoKey: string, categoryKey: string, hash: Buffer) =>
  withSystem(
    REASON,
    (tx) =>
      tx
        .select()
        .from(languageMixes)
        .where(
          and(
            eq(languageMixes.geoKey, geoKey),
            eq(languageMixes.categoryKey, categoryKey),
            eq(languageMixes.configHash, hash),
            gt(languageMixes.fetchedAt, sql`now() - make_interval(days => ${REUSE_DAYS})`),
          ),
        )
        .then(([row]) => row ?? null),
    { readOnly: true },
  );

/** Takes the claim when it is free or its holder died; true when this caller now holds it. */
function claim(name: string): Promise<boolean> {
  const expiresAt = new Date(Date.now() + CLAIM_MS);
  return withSystem(REASON, async (tx) => {
    const taken = await tx
      .insert(languageMixClaims)
      .values({ key: name, expiresAt })
      .onConflictDoUpdate({
        target: languageMixClaims.key,
        set: { expiresAt },
        setWhere: lt(languageMixClaims.expiresAt, sql`now()`),
      })
      .returning({ key: languageMixClaims.key });
    return taken.length > 0;
  });
}

const release = (name: string) =>
  withSystem(REASON, (tx) => tx.delete(languageMixClaims).where(eq(languageMixClaims.key, name)));

function store(
  geo: GeoTarget,
  categoryKey: string,
  hash: Buffer,
  f: LanguageVolumes,
  name: string,
) {
  const values = {
    geoKey: geo.key,
    categoryKey,
    configHash: hash,
    level: f.level,
    locationCode: f.locationCode,
    source: f.source,
    shares: sharesOf(f.volumes),
    volumes: f.volumes,
    cost_amount_micros: f.costMicros,
    cost_currency: "USD",
  };
  // The row appears and the claim goes in one commit, so a waiter never sees neither.
  return withSystem(REASON, async (tx) => {
    const [row] = await tx
      .insert(languageMixes)
      .values(values)
      .onConflictDoUpdate({
        target: [languageMixes.geoKey, languageMixes.categoryKey, languageMixes.configHash],
        set: { ...values, fetchedAt: sql`now()` },
      })
      .returning();
    await tx.delete(languageMixClaims).where(eq(languageMixClaims.key, name));
    return row as Row;
  });
}

const degradeOf = (error: unknown): LanguageMixDegraded =>
  error instanceof SpendCapExceededError ? "spend_cap" : "unavailable";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function untilDeadline(work: Promise<LanguageMix>, deadlineAt: number): Promise<LanguageMix> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<LanguageMix>((resolve) => {
    timer = setTimeout(
      () => resolve(unmeasuredMix("deadline")),
      Math.max(0, deadlineAt - Date.now()),
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * How the place's searches for the category split among the languages `terms` names, shared by
 * every business there for 30 days. One caller per key fetches it, holding a committed claim; the
 * others poll. A fetch that misses the deadline goes on and stores the mix for the next report,
 * while this caller gets the main language alone with the reason; so does a failed fetch. Never
 * throws for a provider or spend failure.
 */
export async function estimateLanguageMix(
  input: EstimateLanguageMixInput,
  opts: EstimateOptions = {},
): Promise<LanguageMix> {
  const { geo, categoryKey, terms, deadlineAt } = input;
  const main = placeLanguage(geo);
  // With words in one language there is nothing to split, and nothing worth paying for.
  if (Object.values(terms).filter((list) => list && list.length > 0).length < 2) {
    return { ...unmeasuredMix("unavailable"), degraded: null };
  }
  const hash = configHash(terms);
  const name = `${geo.key}|${categoryKey}|${hash.toString("hex")}`;
  const hit = cache.get(name);
  if (hit?.asOf && Date.parse(hit.asOf) > Date.now() - REUSE_MS) return hit;

  const startedAt = performance.now();
  const outcome = (mix: LanguageMix, result: string) => {
    log.info("capture.language_mix", {
      result,
      level: mix.level ?? "none",
      degraded: mix.degraded ?? "none",
      ms: Math.round(performance.now() - startedAt),
    });
    return mix;
  };
  const row = await findRow(geo.key, categoryKey, hash);
  if (row) return outcome(remember(name, mixOf(row, main)), "reused");

  const fetchClaimed = async (): Promise<LanguageMix> => {
    try {
      const fetched = await fetchLanguageVolumes(geo, terms, {
        refId: hash.toString("hex"),
        base: opts.base,
      });
      const stored = await store(geo, categoryKey, hash, fetched, name);
      log.info("capture.language_mix_fetched", {
        level: fetched.level,
        source: fetched.source ?? "none",
        cost_micros: fetched.costMicros,
        ms: Math.round(performance.now() - startedAt),
      });
      return remember(name, mixOf(stored, main));
    } catch (error) {
      await release(name).catch(() => undefined);
      log.warn("capture.language_mix_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
      return unmeasuredMix(degradeOf(error));
    }
  };

  if (await claim(name)) {
    return outcome(await untilDeadline(fetchClaimed(), deadlineAt), "fetched");
  }
  while (Date.now() < deadlineAt) {
    await sleep(Math.min(POLL_MS, Math.max(0, deadlineAt - Date.now())));
    // The holder drops its claim in the commit that adds the row, so the claim is read first.
    const held = await withSystem(
      REASON,
      (tx) =>
        tx
          .select({ expired: sql<boolean>`${languageMixClaims.expiresAt} < now()` })
          .from(languageMixClaims)
          .where(eq(languageMixClaims.key, name))
          .then(([r]) => r ?? null),
      { readOnly: true },
    );
    const found = await findRow(geo.key, categoryKey, hash);
    if (found) return outcome(remember(name, mixOf(found, main)), "waited");
    if (held === null) return outcome(unmeasuredMix("unavailable"), "holder_failed");
    if (held.expired && (await claim(name))) {
      return outcome(await untilDeadline(fetchClaimed(), deadlineAt), "fetched");
    }
  }
  return outcome(unmeasuredMix("deadline"), "deadline");
}
