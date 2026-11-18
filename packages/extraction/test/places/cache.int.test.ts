import { createHash, randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import type { SpendContext } from "@reranker/jobs";
import { expectNoSeqScanOn, explain } from "@reranker/testing/db";
import { server } from "@reranker/testing/msw";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { HttpResponse, http } from "msw";
import pg from "pg";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  type CachedDecision,
  readDecisions,
  readDecisionsQuery,
  refreshStalePlaceIds,
  writeDecisions,
} from "../../src/places/cache";

beforeAll(() => {
  vi.stubEnv("APP_ENV", process.env.APP_ENV ?? "development");
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "places-integration-key");
  server.listen();
});
afterAll(async () => {
  server.close();
  vi.unstubAllEnvs();
  await endPools();
});

const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
const RUN = randomUUID();
const H = hex(`config:${RUN}`);
const GEO = "co-ant-medellin";
const CATEGORY = "odontologia";
const spend: SpendContext = { purpose: "quality-canary", refType: "places-refresh", refId: RUN };

const k = (name: string) => ({
  nameHmac: hex(`${RUN}:${name}`),
  geoKey: GEO,
  categoryKey: CATEGORY,
});
const key = (name: string) => `${hex(`${RUN}:${name}`)}|${GEO}|${CATEGORY}`;
const row = (name: string, decision: CachedDecision) => ({ ...k(name), decision });
const placeId = (name: string) => `ChIJ_${RUN}_${name}`;
const place = (name: string): CachedDecision => ({
  outcome: "place",
  placeId: placeId(name),
  score: 0.94,
  method: "rules",
});
const unresolvable = (): CachedDecision => ({
  outcome: "unresolvable",
  score: 0.41,
  method: "rules",
});
const chain = (): CachedDecision => ({ outcome: "chain", score: 0.95, method: "rules" });

// The writes stamp the database clock; age is set afterwards, as only time would.
async function age(name: string, column: "decided_at" | "validated_at", days: number) {
  await withSystem("extraction.test", (tx) =>
    tx.execute(
      sql`update public_panel.places set ${sql.identifier(column)} = now() - make_interval(days => ${days})
          where name_hmac = ${Buffer.from(k(name).nameHmac, "hex")} and config_hash = ${Buffer.from(H, "hex")}`,
    ),
  );
}

test("one query reads every key and unresolvable older than 30 days is a miss", async () => {
  await writeDecisions([row("a", place("a")), row("b", unresolvable()), row("c", chain())], H);
  await age("b", "decided_at", 31);
  const m = await readDecisions([k("a"), k("b"), k("c")], H);
  expect([...m.keys()].sort()).toEqual([key("a"), key("c")].sort());
  expect(m.get(key("a"))).toEqual(place("a"));
  expect(m.get(key("c"))).toEqual(chain());
  expect(await readDecisions([], H)).toEqual(new Map());
});

test("a place decision never expires; another config hash is a miss", async () => {
  await writeDecisions([row("d", place("d")), row("e", unresolvable())], H);
  await age("d", "decided_at", 400);
  await age("e", "decided_at", 29);
  const m = await readDecisions([k("d"), k("e")], H);
  expect(m.get(key("d"))).toEqual(place("d"));
  expect(m.get(key("e"))).toEqual(unresolvable());
  expect((await readDecisions([k("d"), k("e")], hex(`other:${RUN}`))).size).toBe(0);
});

test("a new decision for the same key replaces the old one", async () => {
  await writeDecisions([row("f", unresolvable())], H);
  await writeDecisions([row("f", place("f")), row("f", chain())], H);
  expect((await readDecisions([k("f")], H)).get(key("f"))).toEqual(chain());
  await writeDecisions([], H);
});

test("refresh follows movedPlaceId and drops ids that no longer exist", async () => {
  const asked: string[] = [];
  server.use(
    http.get("https://places.googleapis.com/v1/places/:placeId", ({ params, request }) => {
      const id = String(params.placeId);
      asked.push(`${id} ${request.headers.get("x-goog-fieldmask")}`);
      if (id === placeId("g")) return HttpResponse.json({ id, movedPlaceId: placeId("g2") });
      if (id === placeId("h")) {
        return HttpResponse.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
      }
      return HttpResponse.json({ id });
    }),
  );
  await writeDecisions([row("g", place("g")), row("h", place("h"))], H);
  // Older than anything another run could leave behind, so they are the stalest rows.
  await age("g", "validated_at", 36_500);
  await age("h", "validated_at", 36_499);

  expect(await refreshStalePlaceIds(2, spend)).toEqual({ checked: 2, moved: 1, gone: 1 });
  expect(asked.sort()).toEqual([
    `${placeId("g")} id,movedPlaceId`,
    `${placeId("h")} id,movedPlaceId`,
  ]);
  const m = await readDecisions([k("g"), k("h")], H);
  expect(m.get(key("g"))).toEqual(place("g2"));
  expect(m.has(key("h"))).toBe(false);
  const { rows } = await withSystem("extraction.test", (tx) =>
    tx.execute<{ fresh: boolean }>(
      sql`select validated_at > now() - interval '1 minute' as fresh from public_panel.places
          where name_hmac = ${Buffer.from(k("g").nameHmac, "hex")} and config_hash = ${Buffer.from(H, "hex")}`,
    ),
  );
  expect(rows).toEqual([{ fresh: true }]);
});

// Seeded and analyzed inside a transaction that is rolled back, so no other suite sees the rows
// and the planner sees the statistics of a table that size.
test("reading 15 keys uses the primary key index", async () => {
  const db = new pg.Client({ connectionString: getTestDatabaseUrl("migrations") });
  await db.connect();
  try {
    await db.query("begin");
    await db.query(
      `insert into public_panel.places (name_hmac, geo_key, category_key, config_hash, outcome, method, score)
       select sha256(convert_to('seed:' || g, 'UTF8')), 'geo-' || (g % 50), 'cat-' || (g % 20),
              sha256(convert_to($1, 'UTF8')), 'chain', 'rules', 0.9
         from generate_series(0, 9999) g`,
      [RUN],
    );
    await db.query("analyze public_panel.places");
    const keys = Array.from({ length: 15 }, (_, i) => k(`explain-${i}`));
    const query = new PgDialect().sqlToQuery(readDecisionsQuery(keys, H));
    expectNoSeqScanOn(await explain(db, query.sql, query.params), "places");
  } finally {
    await db.query("rollback");
    await db.end();
  }
});
