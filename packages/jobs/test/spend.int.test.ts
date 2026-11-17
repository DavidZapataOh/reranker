import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { resetAppEnv } from "@reranker/env";
import { cost, type ProviderCost } from "@reranker/schema";
import { type SQL, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { type JobsConfig, loadJobsConfig } from "../src/config";
import { nextResetAt, spendDay } from "../src/day";
import { InvalidInputError, SpendCapExceededError } from "../src/errors";
import type { PaidProvider, SpendPool, SpendPurpose } from "../src/providers";
import {
  costOf,
  releaseSpend,
  releaseStaleSpend,
  reserveSpend,
  type SpendRequest,
  type SpendReservation,
  settleSpend,
  spendStatus,
} from "../src/spend";

// Caps come from the environment once per process; each test swaps in its own.
const state = vi.hoisted(() => ({ config: undefined as JobsConfig | undefined }));
vi.mock("../src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config")>();
  return {
    ...actual,
    loadJobsConfig: (source?: Parameters<typeof actual.loadJobsConfig>[0]) =>
      source ? actual.loadJobsConfig(source) : (state.config ?? actual.loadJobsConfig()),
  };
});

// Concurrency is real only with more connections than the default three of the system pool.
const CONNECTIONS = 20;
const savedAppEnv = process.env.APP_ENV;
beforeAll(() => {
  process.env.DB_POOL_MAX = String(CONNECTIONS);
});
afterAll(async () => {
  process.env.APP_ENV = savedAppEnv;
  resetAppEnv();
  await endPools();
});

function useAppEnv(name: "production" | "development") {
  process.env.APP_ENV = name;
  resetAppEnv();
  state.config = loadJobsConfig({ APP_ENV: name });
}

// Every test runs on a spend day of its own, so counters, ledgers and stale reservations of one
// test (or of another run sharing the database) never meet another's. Noon in Bogota is 17:00Z.
let today: string;
function travelTo(instant: Date) {
  vi.setSystemTime(instant);
  today = spendDay();
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const year = 2100 + Math.floor(Math.random() * 800);
  const dayOfYear = Math.floor(Math.random() * 365);
  travelTo(new Date(Date.UTC(year, 0, 1 + dayOfYear, 17)));
  useAppEnv("production");
});
afterEach(() => {
  vi.useRealTimers();
});

const usd = (micros: number) => cost(micros, "USD");

function withCaps(caps: Record<string, number>) {
  const base = state.config as JobsConfig;
  const next = { ...base.caps } as Record<string, ProviderCost>;
  for (const [scope, micros] of Object.entries(caps)) next[scope] = usd(micros);
  state.config = { ...base, caps: next as JobsConfig["caps"] };
}

const req = (micros: number, overrides: Partial<SpendRequest> = {}): SpendRequest => ({
  provider: "dataforseo",
  channel: "api",
  purpose: "benchmark",
  refType: "test",
  refId: randomUUID(),
  estimate: usd(micros),
  ...overrides,
});

const system = async <R extends Record<string, unknown>>(query: SQL): Promise<R[]> =>
  (await withSystem("test.spend", (tx) => tx.execute(query))).rows as R[];

const usedOf = async (scope: string, day = today) => {
  const [row] = await system<{ used: string }>(sql`select used_amount_micros as used
    from ops.spend_counters where day = ${day}::date and scope = ${scope}`);
  return row ? Number(row.used) : 0;
};

const ledgerRow = async (id: string) => {
  const [row] = await system<{ status: string; scopes: string[]; pool: string | null }>(
    sql`select status, scopes, pool from ops.spend_ledger where id = ${id}::uuid`,
  );
  if (!row) throw new Error(`no ledger row ${id}`);
  return row;
};
const ledgerStatus = async (id: string) => (await ledgerRow(id)).status;

const ageReservation = (id: string, minutes: number) =>
  system(sql`update ops.spend_ledger set created_at = created_at - make_interval(mins => ${minutes})
    where id = ${id}::uuid`);

// Every connection stays busy at once, but no call queues in pg-pool, whose 2 s checkout timeout
// would otherwise fail calls stuck behind a contended row lock on a remote database.
async function race<T>(n: number, fn: (i: number) => Promise<T>) {
  const results: PromiseSettledResult<T>[] = new Array(n);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < n; i = next++) {
      try {
        results[i] = { status: "fulfilled", value: await fn(i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, CONNECTIONS) }, worker));
  return results;
}
const granted = <T>(results: PromiseSettledResult<T>[]) =>
  results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
const denials = <T>(results: PromiseSettledResult<T>[]) =>
  results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));

describe("reserveSpend", () => {
  test("US$1 cap with 100 concurrent US$0.04 reservations grants exactly 25", async () => {
    withCaps({ global: 1_000_000 });
    const results = await race(100, () => reserveSpend(req(40_000)));
    expect(granted(results)).toHaveLength(25);
    const errors = denials(results);
    expect(errors).toHaveLength(75);
    for (const error of errors) {
      expect(error).toBeInstanceOf(SpendCapExceededError);
      expect(error).toMatchObject({ scope: "global" });
      expect((error as SpendCapExceededError).resetsAt.toISOString()).toBe(
        nextResetAt().toISOString(),
      );
    }
    const [status] = await spendStatus(["global"]);
    expect(status?.used.amount_micros).toBe(1_000_000);
    expect(await usedOf("global")).toBe(1_000_000);
  });

  test("reservations of different providers and purposes share the global cap without exceeding it", async () => {
    withCaps({ global: 1_000_000 });
    const mixes: Array<Partial<SpendRequest>> = [
      { provider: "dataforseo", purpose: "benchmark" },
      { provider: "openai", purpose: "quality-canary" },
      { provider: "gemini", purpose: "control-canary" },
      { provider: "brightdata", purpose: "benchmark" },
    ];
    const results = await race(100, (i) => reserveSpend(req(40_000, mixes[i % mixes.length])));
    expect(granted(results)).toHaveLength(25);
    expect(await usedOf("global")).toBe(1_000_000);
    const perProvider = await Promise.all(
      ["dataforseo", "openai", "gemini", "brightdata"].map((p) => usedOf(`provider:${p}`)),
    );
    expect(perProvider.reduce((a, b) => a + b, 0)).toBe(1_000_000);
  });

  test("returns the scopes charged with their used amount and cap, global first", async () => {
    const r = await reserveSpend(req(4000, { provider: "openai", purpose: "quality-canary" }));
    expect(r.reserved).toEqual(usd(4000));
    expect(r.scopes).toEqual([
      { scope: "global", used: usd(4000), cap: usd(75_000_000) },
      { scope: "purpose:quality-canary", used: usd(4000), cap: usd(3_000_000) },
      { scope: "provider:openai", used: usd(4000), cap: usd(14_000_000) },
    ]);
  });

  test("a provider cap stops its provider and leaves the others alone", async () => {
    withCaps({ "provider:openai": 50_000 });
    await reserveSpend(req(40_000, { provider: "openai" }));
    await expect(reserveSpend(req(40_000, { provider: "openai" }))).rejects.toMatchObject({
      scope: "provider:openai",
    });
    await expect(reserveSpend(req(40_000, { provider: "gemini" }))).resolves.toBeDefined();
  });

  test("a zero estimate passes even on a zero cap", async () => {
    withCaps({ "provider:dataforseo": 0 });
    await expect(reserveSpend(req(0))).resolves.toMatchObject({ reserved: usd(0) });
    await expect(reserveSpend(req(1))).rejects.toMatchObject({ scope: "provider:dataforseo" });
  });
});

describe("pools", () => {
  const freeReport = (pool: "free-report-anonymous" | "free-report-verified") =>
    ({ purpose: "free-report", pool }) as const;

  beforeEach(() =>
    withCaps({
      "purpose:free-report": 1_000_000,
      "pool:free-report-anonymous": 600_000,
      "pool:free-report-verified": 400_000,
      "pool:free-report-elsewhere": 200_000,
    }),
  );

  test("anonymous gets exactly 15, verified keeps 10 more, nobody exceeds its cap", async () => {
    const anon = await race(100, () =>
      reserveSpend(req(40_000, freeReport("free-report-anonymous"))),
    );
    expect(granted(anon)).toHaveLength(15);
    expect(denials(anon)[0]).toMatchObject({ scope: "pool:free-report-anonymous" });
    const verified = await race(20, () =>
      reserveSpend(req(40_000, freeReport("free-report-verified"))),
    );
    expect(granted(verified)).toHaveLength(10);
    expect(await usedOf("purpose:free-report")).toBe(1_000_000);
    expect(await usedOf("pool:free-report-anonymous")).toBe(600_000);
    expect(await usedOf("pool:free-report-verified")).toBe(400_000);
  });

  test("fallbackPool lets anonymous borrow verified in one transaction", async () => {
    const results = await race(40, () =>
      reserveSpend(
        req(40_000, {
          ...freeReport("free-report-anonymous"),
          fallbackPool: "free-report-verified",
        }),
      ),
    );
    const ok = granted(results);
    expect(ok).toHaveLength(25);
    expect(await usedOf("purpose:free-report")).toBe(1_000_000);
    expect(await usedOf("pool:free-report-anonymous")).toBe(600_000);
    expect(await usedOf("pool:free-report-verified")).toBe(400_000);
    const borrowed = ok.filter((r) =>
      r.scopes.some((s) => s.scope === "pool:free-report-verified"),
    );
    expect(borrowed).toHaveLength(10);
    expect(await ledgerRow((borrowed[0] as SpendReservation).id)).toMatchObject({
      pool: "free-report-verified",
      scopes: ["global", "pool:free-report-verified", "purpose:free-report", "provider:dataforseo"],
    });
  });

  test("when the fallback is short too, the denial names the reservation's own pool", async () => {
    withCaps({
      "purpose:free-report": 10_000_000,
      "pool:free-report-anonymous": 40_000,
      "pool:free-report-verified": 40_000,
    });
    const anonymous = {
      ...freeReport("free-report-anonymous"),
      fallbackPool: "free-report-verified",
    } as const;
    await reserveSpend(req(40_000, anonymous));
    await reserveSpend(req(40_000, anonymous));
    await expect(reserveSpend(req(40_000, anonymous))).rejects.toMatchObject({
      scope: "pool:free-report-anonymous",
    });
    await expect(
      reserveSpend(req(40_000, freeReport("free-report-verified"))),
    ).rejects.toMatchObject({ scope: "pool:free-report-verified" });
  });

  test("reservations outside Colombia stop at the elsewhere cap and Colombian ones fill their pool", async () => {
    const abroad = await race(100, (i) =>
      reserveSpend(
        req(40_000, { ...freeReport("free-report-anonymous"), country: i % 2 ? "MX" : "ES" }),
      ),
    );
    expect(granted(abroad)).toHaveLength(5);
    expect(denials(abroad)[0]).toMatchObject({ scope: "pool:free-report-elsewhere" });
    expect(await usedOf("pool:free-report-elsewhere")).toBe(200_000);
    const colombia = await race(100, () =>
      reserveSpend(req(40_000, { ...freeReport("free-report-anonymous"), country: "CO" })),
    );
    expect(granted(colombia)).toHaveLength(10);
    expect(await usedOf("pool:free-report-anonymous")).toBe(600_000);
    expect(await usedOf("pool:free-report-elsewhere")).toBe(200_000);
  });

  test("racing reservations from Colombia and elsewhere never exceed any cap", async () => {
    const results = await race(100, (i) =>
      reserveSpend(
        req(40_000, { ...freeReport("free-report-anonymous"), country: i % 2 ? "CO" : "US" }),
      ),
    );
    const ok = granted(results);
    expect(ok).toHaveLength(15);
    const abroad = ok.filter((r) => r.scopes.some((s) => s.scope === "pool:free-report-elsewhere"));
    expect(abroad.length).toBeLessThanOrEqual(5);
    expect(await usedOf("pool:free-report-elsewhere")).toBe(abroad.length * 40_000);
    expect(await usedOf("pool:free-report-anonymous")).toBe(600_000);
    expect(await usedOf("purpose:free-report")).toBe(600_000);
  });

  test("a reservation from elsewhere stays charged to elsewhere when it borrows the fallback", async () => {
    withCaps({ "pool:free-report-anonymous": 40_000, "pool:free-report-verified": 960_000 });
    const abroad = {
      ...freeReport("free-report-anonymous"),
      fallbackPool: "free-report-verified",
      country: "MX",
    } as const;
    await reserveSpend(req(40_000, abroad));
    const borrowed = await reserveSpend(req(40_000, abroad));
    expect(borrowed.scopes.map((s) => s.scope)).toEqual([
      "global",
      "pool:free-report-verified",
      "pool:free-report-elsewhere",
      "purpose:free-report",
      "provider:dataforseo",
    ]);
    expect(await usedOf("pool:free-report-elsewhere")).toBe(80_000);
  });

  test("a free report with no pool and no country is charged to its purpose only", async () => {
    const r = await reserveSpend(req(4000, { purpose: "free-report" }));
    expect(r.scopes.map((s) => s.scope)).toEqual([
      "global",
      "purpose:free-report",
      "provider:dataforseo",
    ]);
  });
});

describe("contract tests", () => {
  test("outside production they spend under their own cap, not the zero provider cap", async () => {
    useAppEnv("development");
    const r = await reserveSpend(req(100_000, { provider: "openai", purpose: "contract-test" }));
    expect(r.scopes.map((s) => s.scope)).toEqual(["global", "purpose:contract-test"]);
    const more = await race(10, () =>
      reserveSpend(req(100_000, { provider: "openai", purpose: "contract-test" })),
    );
    expect(granted(more)).toHaveLength(4);
    expect(denials(more)[0]).toMatchObject({ scope: "purpose:contract-test" });
    await expect(
      reserveSpend(req(1, { provider: "openai", purpose: "benchmark" })),
    ).rejects.toMatchObject({ scope: "provider:openai" });
  });

  test("in production they also count against the provider cap", async () => {
    const r = await reserveSpend(req(100_000, { provider: "openai", purpose: "contract-test" }));
    expect(r.scopes.map((s) => s.scope)).toEqual([
      "global",
      "purpose:contract-test",
      "provider:openai",
    ]);
  });
});

describe("settleSpend and releaseSpend", () => {
  test("reserve 4000 then settle 3100 leaves used 3100 and the ledger settled", async () => {
    const refId = randomUUID();
    const r = await reserveSpend(req(4000, { refType: "free_report", refId }));
    await settleSpend(r, usd(3100));
    expect(await usedOf("provider:dataforseo")).toBe(3100);
    expect(await usedOf("global")).toBe(3100);
    expect(await ledgerStatus(r.id)).toBe("settled");
    expect(await costOf("free_report", refId)).toEqual(usd(3100));
  });

  test("costOf sums settled actuals only", async () => {
    const refId = randomUUID();
    const settled = await reserveSpend(req(4000, { refType: "free_report", refId }));
    const released = await reserveSpend(req(4000, { refType: "free_report", refId }));
    await reserveSpend(req(4000, { refType: "free_report", refId }));
    await settleSpend(settled, usd(2500));
    await releaseSpend(released);
    expect(await costOf("free_report", refId)).toEqual(usd(2500));
    expect(await costOf("free_report", randomUUID())).toEqual(usd(0));
  });

  test("settle and release are idempotent under step retries", async () => {
    const r = await reserveSpend(req(4000));
    await settleSpend(r, usd(3100));
    await settleSpend(r, usd(3100));
    await releaseSpend(r);
    expect(await usedOf("global")).toBe(3100);
    expect(await ledgerStatus(r.id)).toBe("settled");
  });

  test("concurrent retries of one settle or release apply exactly once", async () => {
    const settled = await reserveSpend(req(4000));
    const released = await reserveSpend(req(4000));
    await race(20, (i) => (i % 2 ? settleSpend(settled, usd(3100)) : releaseSpend(released)));
    expect(await usedOf("global")).toBe(3100);
    expect(await ledgerStatus(settled.id)).toBe("settled");
    expect(await ledgerStatus(released.id)).toBe("released");

    const contested = await reserveSpend(req(4000));
    await race(20, (i) => (i % 2 ? settleSpend(contested, usd(3100)) : releaseSpend(contested)));
    const status = await ledgerStatus(contested.id);
    expect(await usedOf("global")).toBe(status === "settled" ? 6200 : 3100);
  });

  test("release gives the whole reservation back", async () => {
    withCaps({ global: 100_000 });
    const r = await reserveSpend(req(100_000));
    await releaseSpend(r);
    expect(await usedOf("global")).toBe(0);
    await expect(reserveSpend(req(100_000))).resolves.toBeDefined();
  });

  test("an actual above the reservation is recorded even past the cap", async () => {
    withCaps({ global: 100_000 });
    const r = await reserveSpend(req(100_000));
    await settleSpend(r, usd(150_000));
    expect(await usedOf("global")).toBe(150_000);
    expect(await usedOf("provider:dataforseo")).toBe(150_000);
    await expect(reserveSpend(req(1))).rejects.toMatchObject({ scope: "global" });
  });

  test("settling after midnight adjusts the reservation's day", async () => {
    const day = today;
    // 23:59 in Bogota, then 00:01 of the next local day.
    travelTo(new Date(`${day}T23:59:00-05:00`));
    const r = await reserveSpend(req(4000));
    travelTo(new Date(Date.parse(`${day}T23:59:00-05:00`) + 2 * 60_000));
    expect(today).not.toBe(day);
    await settleSpend(r, usd(1000));
    expect(await usedOf("global", day)).toBe(1000);
    expect(await usedOf("global")).toBe(0);
  });
});

describe("stale reservations", () => {
  test("are released when a cap looks exhausted", async () => {
    withCaps({ global: 100_000 });
    const r = await reserveSpend(req(100_000));
    await ageReservation(r.id, 16);
    await expect(reserveSpend(req(50_000))).resolves.toBeDefined();
    expect(await ledgerStatus(r.id)).toBe("released");
    expect(await usedOf("global")).toBe(50_000);
  });

  test("younger than 15 minutes are kept, so a cap that is really full stays full", async () => {
    withCaps({ global: 100_000 });
    const r = await reserveSpend(req(100_000));
    await ageReservation(r.id, 14);
    await expect(reserveSpend(req(50_000))).rejects.toBeInstanceOf(SpendCapExceededError);
    expect(await ledgerStatus(r.id)).toBe("reserved");
  });

  test("releaseStaleSpend frees a day's old reservations and nothing else", async () => {
    const stale = await reserveSpend(req(4000));
    const fresh = await reserveSpend(req(4000));
    const done = await reserveSpend(req(4000));
    await settleSpend(done, usd(3000));
    await ageReservation(stale.id, 16);
    await ageReservation(done.id, 16);
    expect(await releaseStaleSpend(today)).toBe(1);
    expect(await ledgerStatus(stale.id)).toBe("released");
    expect(await ledgerStatus(fresh.id)).toBe("reserved");
    expect(await usedOf("global")).toBe(7000);
    // The step that held the stale reservation is gone; a late settle counts nothing twice.
    await settleSpend(stale, usd(4000));
    expect(await usedOf("global")).toBe(7000);
    expect(await releaseStaleSpend(today)).toBe(0);
  });
});

describe("spendStatus", () => {
  test("reports cap, used and reset for each scope asked, in order", async () => {
    await reserveSpend(req(4000, { provider: "openai" }));
    const status = await spendStatus(["provider:openai", "global", "pool:free-report-verified"]);
    expect(status).toEqual([
      { scope: "provider:openai", cap: usd(14_000_000), used: usd(4000), resetsAt: nextResetAt() },
      { scope: "global", cap: usd(75_000_000), used: usd(4000), resetsAt: nextResetAt() },
      {
        scope: "pool:free-report-verified",
        cap: usd(20_000_000),
        used: usd(0),
        resetsAt: nextResetAt(),
      },
    ]);
  });

  test("rejects a scope that has no cap", async () => {
    await expect(spendStatus(["provider:nobody"])).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("invalid input", () => {
  test.each<[string, Partial<SpendRequest>]>([
    [
      "a pool without the free-report purpose",
      { purpose: "benchmark", pool: "free-report-verified" },
    ],
    ["a country without the free-report purpose", { purpose: "benchmark", country: "MX" }],
    ["a fallback without a pool", { purpose: "free-report", fallbackPool: "free-report-verified" }],
    [
      "a fallback equal to the pool",
      {
        purpose: "free-report",
        pool: "free-report-verified",
        fallbackPool: "free-report-verified",
      },
    ],
    ["an unknown provider", { provider: "nobody" as PaidProvider }],
    ["an unknown purpose", { purpose: "fun" as SpendPurpose }],
    ["an unknown pool", { purpose: "free-report", pool: "elsewhere" as SpendPool }],
    ["an estimate in another currency", { estimate: cost(1000, "COP") }],
    ["a negative estimate", { estimate: { amount_micros: -1, currency: "USD" } }],
    ["a fractional estimate", { estimate: { amount_micros: 1.5, currency: "USD" } }],
    ["an empty reference", { refId: "" }],
  ])("rejects %s", async (_, overrides) => {
    await expect(reserveSpend(req(1000, overrides))).rejects.toBeInstanceOf(InvalidInputError);
  });

  test("settle and release reject another currency or a malformed reservation id", async () => {
    const r = await reserveSpend(req(4000));
    await expect(settleSpend(r, cost(1000, "COP"))).rejects.toBeInstanceOf(InvalidInputError);
    await expect(settleSpend({ ...r, id: "not-a-uuid" }, usd(1))).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(releaseSpend({ ...r, id: "not-a-uuid" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    expect(await ledgerStatus(r.id)).toBe("reserved");
  });

  test("releaseStaleSpend needs a calendar day", async () => {
    await expect(releaseStaleSpend("yesterday")).rejects.toBeInstanceOf(InvalidInputError);
  });
});
