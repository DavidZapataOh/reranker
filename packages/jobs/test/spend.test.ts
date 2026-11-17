import { resetAppEnv } from "@reranker/env";
import { AppError, cost } from "@reranker/schema";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const execute = vi.fn();
const withSystem = vi.fn(async (_reason: string, fn: (tx: unknown) => unknown) => fn({ execute }));
vi.mock("@reranker/db", () => ({ withSystem }));

const savedAppEnv = process.env.APP_ENV;
process.env.APP_ENV = "production";
resetAppEnv();
afterAll(() => {
  process.env.APP_ENV = savedAppEnv;
  resetAppEnv();
});

const { InvalidInputError, SpendCapExceededError } = await import("../src/errors");
const { costOf, releaseSpend, releaseStaleSpend, reserveSpend, settleSpend, spendStatus } =
  await import("../src/spend");
type SpendRequest = import("../src/spend").SpendRequest;

const usd = (micros: number) => cost(micros, "USD");
const ID = "0190a6c4-2f1b-7c3e-8a5d-9e8f7a6b5c4d";
const req = (overrides: Partial<SpendRequest> = {}): SpendRequest => ({
  provider: "dataforseo",
  purpose: "benchmark",
  refType: "free_report",
  refId: "r1",
  estimate: usd(40_000),
  ...overrides,
});

const freeReport = (overrides: Partial<SpendRequest> = {}) =>
  req({ purpose: "free-report", pool: "free-report-anonymous", country: "CO", ...overrides });

const dialect = new PgDialect();
const params = (call = 0) => dialect.sqlToQuery(execute.mock.calls[call]?.[0] as SQL).params;

const granted = (scopes: string[]) => ({
  rows: [
    {
      ledger_id: ID,
      denied_scope: null,
      scopes,
      used: scopes.map(() => "40000"),
      caps: scopes.map(() => "75000000"),
    },
  ],
});
const denied = (scope: string | null, scopes = ["global"]) => ({
  rows: [{ ledger_id: null, denied_scope: scope, scopes, used: [], caps: [] }],
});

beforeEach(() => {
  execute.mockReset();
  withSystem.mockClear();
  process.env.APP_ENV = "production";
  resetAppEnv();
});

describe("reserveSpend", () => {
  test("is one system statement with global first, the configured caps and the ledger", async () => {
    execute.mockResolvedValue(granted(["global", "pool:free-report-anonymous"]));
    const r = await reserveSpend(
      freeReport({
        channel: "ui-vendor",
        engine: "chatgpt",
        pool: "free-report-anonymous",
        fallbackPool: "free-report-verified",
        country: "MX",
      }),
    );
    expect(withSystem).toHaveBeenCalledTimes(1);
    expect(withSystem.mock.calls[0]?.[0]).toBe("jobs.spend");
    expect(execute).toHaveBeenCalledTimes(1);
    const [day, scopes, caps, fallback, fallbackCap, amount, ledger] = params();
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(scopes).toEqual([
      "global",
      "pool:free-report-anonymous",
      "pool:free-report-elsewhere",
      "purpose:free-report",
      "provider:dataforseo",
    ]);
    expect(caps).toEqual([75_000_000, 30_000_000, 20_000_000, 50_000_000, 36_000_000]);
    expect([fallback, fallbackCap, amount]).toEqual([
      "pool:free-report-verified",
      20_000_000,
      40_000,
    ]);
    expect(JSON.parse(ledger as string)).toEqual({
      provider: "dataforseo",
      channel: "ui-vendor",
      engine: "chatgpt",
      purpose: "free-report",
      pool: "free-report-anonymous",
      ref_type: "free_report",
      ref_id: "r1",
      currency: "USD",
    });
    expect(r).toEqual({
      id: ID,
      reserved: usd(40_000),
      provider: "dataforseo",
      purpose: "free-report",
      scopes: [
        { scope: "global", used: usd(40_000), cap: usd(75_000_000) },
        { scope: "pool:free-report-anonymous", used: usd(40_000), cap: usd(75_000_000) },
      ],
    });
  });

  test("sends no fallback, channel or engine when none is given, and Colombia skips elsewhere", async () => {
    execute.mockResolvedValue(granted(["global"]));
    await reserveSpend(freeReport());
    const [, scopes, , fallback, fallbackCap, , ledger] = params();
    expect(scopes).toEqual([
      "global",
      "pool:free-report-anonymous",
      "purpose:free-report",
      "provider:dataforseo",
    ]);
    expect([fallback, fallbackCap]).toEqual([null, null]);
    expect(JSON.parse(ledger as string)).toMatchObject({ channel: null, engine: null });
  });

  test("contract tests skip the provider scope outside production only", async () => {
    execute.mockResolvedValue(granted(["global"]));
    await reserveSpend(req({ purpose: "contract-test", provider: "openai" }));
    expect(params(0)[1]).toEqual(["global", "purpose:contract-test", "provider:openai"]);
    process.env.APP_ENV = "preview";
    resetAppEnv();
    await reserveSpend(req({ purpose: "contract-test", provider: "openai" }));
    expect(params(1)[1]).toEqual(["global", "purpose:contract-test"]);
  });

  test("a denial names its scope and the next local midnight", async () => {
    execute.mockResolvedValue(denied("purpose:benchmark"));
    const error = await reserveSpend(req()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpendCapExceededError);
    expect(error).toMatchObject({ scope: "purpose:benchmark" });
    expect(
      (error as InstanceType<typeof SpendCapExceededError>).resetsAt.getTime(),
    ).toBeGreaterThan(Date.now());
  });

  test("a denial on the fallback pool is reported on the reservation's own pool", async () => {
    execute.mockResolvedValue(denied("pool:free-report-anonymous"));
    const verified = freeReport({
      pool: "free-report-verified",
      fallbackPool: "free-report-anonymous",
    });
    await expect(reserveSpend(verified)).rejects.toMatchObject({
      scope: "pool:free-report-verified",
    });
    execute.mockResolvedValue(denied("pool:free-report-elsewhere"));
    await expect(reserveSpend({ ...verified, country: "AR" })).rejects.toMatchObject({
      scope: "pool:free-report-elsewhere",
    });
  });

  test("fails loudly when the function returns nothing or denies without a scope", async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(reserveSpend(req())).rejects.toThrow("no row");
    execute.mockResolvedValue(denied(null));
    await expect(reserveSpend(req())).rejects.toThrow("without a scope");
  });

  const fr = { purpose: "free-report", country: "CO" } as const;
  test.each<[string, Partial<SpendRequest>]>([
    ["a pool off the free report", { purpose: "benchmark", pool: "free-report-verified" }],
    ["a country off the free report", { purpose: "quality-canary", country: "MX" }],
    ["a free report without a pool", { purpose: "free-report", country: "CO" }],
    ["a free report without a country", { purpose: "free-report", pool: "free-report-verified" }],
    [
      "the elsewhere pool picked by hand",
      { ...fr, pool: "free-report-elsewhere" as "free-report-verified" },
    ],
    [
      "an unknown fallback",
      { ...fr, pool: "free-report-verified", fallbackPool: "x" as "free-report-verified" },
    ],
    ["a fallback with no pool", { fallbackPool: "free-report-verified" }],
    [
      "a fallback equal to its pool",
      { ...fr, pool: "free-report-verified", fallbackPool: "free-report-verified" },
    ],
    ["an unknown provider", { provider: "acme" as "openai" }],
    [
      "an unknown provider on a contract test",
      { provider: "acme" as "openai", purpose: "contract-test" },
    ],
    ["an unknown purpose", { purpose: "fun" as "benchmark" }],
    ["a COP estimate", { estimate: cost(1, "COP") }],
    ["a negative estimate", { estimate: { amount_micros: -1, currency: "USD" } }],
    ["a zero estimate", { estimate: usd(0) }],
    ["an empty ref type", { refType: "" }],
    ["an empty ref id", { refId: "" }],
  ])("rejects %s before touching the database", async (_, overrides) => {
    await expect(reserveSpend(req(overrides))).rejects.toBeInstanceOf(InvalidInputError);
    expect(withSystem).not.toHaveBeenCalled();
  });

  test("maps a rejected parameter (22023) to invalid input and lets other failures through", async () => {
    execute.mockRejectedValue(new AppError("internal", { cause: { code: "22023" } }));
    await expect(reserveSpend(req())).rejects.toBeInstanceOf(InvalidInputError);
    const outage = new AppError("service_unavailable", { retryAfterSeconds: 2 });
    execute.mockRejectedValue(outage);
    await expect(reserveSpend(req())).rejects.toBe(outage);
    execute.mockRejectedValue(new Error("boom"));
    await expect(reserveSpend(req())).rejects.toThrow("boom");
  });
});

describe("settleSpend and releaseSpend", () => {
  const r = {
    id: ID,
    reserved: usd(4000),
    provider: "openai",
    purpose: "quality-canary",
    scopes: [],
  } as const;

  test("each is one statement on the reservation id and reports whether it applied", async () => {
    const onEvent = vi.fn();
    execute.mockResolvedValue({ rows: [{ applied: true }] });
    await expect(settleSpend(r, usd(5000), { onEvent })).resolves.toEqual({ applied: true });
    expect(params(0)).toEqual([ID, 5000]);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({
      name: "jobs.spend.settled",
      props: { provider: "openai", purpose: "quality-canary", micro_usd: 5000 },
    });
    await expect(releaseSpend(r)).resolves.toEqual({ applied: true });
    expect(params(1)).toEqual([ID]);
    expect(withSystem).toHaveBeenCalledTimes(2);
  });

  test("a settle or release that changed nothing says so and emits nothing", async () => {
    const onEvent = vi.fn();
    execute.mockResolvedValue({ rows: [{ applied: false }] });
    await expect(settleSpend(r, usd(5000), { onEvent })).resolves.toEqual({ applied: false });
    await expect(releaseSpend(r)).resolves.toEqual({ applied: false });
    execute.mockResolvedValue({ rows: [] });
    await expect(settleSpend(r, usd(5000))).rejects.toThrow("no row");
    await expect(releaseSpend(r)).rejects.toThrow("no row");
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("reject a malformed id or another currency before touching the database", async () => {
    await expect(settleSpend({ ...r, id: "x" }, usd(1))).rejects.toBeInstanceOf(InvalidInputError);
    await expect(releaseSpend({ ...r, id: "x" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(settleSpend(r, cost(1, "EUR"))).rejects.toBeInstanceOf(InvalidInputError);
    await expect(settleSpend(r, { amount_micros: 0.5, currency: "USD" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    expect(withSystem).not.toHaveBeenCalled();
  });
});

describe("releaseStaleSpend", () => {
  test("returns the count released for a calendar day", async () => {
    execute.mockResolvedValue({ rows: [{ released: 3 }] });
    await expect(releaseStaleSpend("2026-11-16")).resolves.toBe(3);
    expect(params()).toEqual(["2026-11-16"]);
    execute.mockResolvedValue({ rows: [] });
    await expect(releaseStaleSpend("2026-11-16")).resolves.toBe(0);
    await expect(releaseStaleSpend("2026-13-01")).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("spendStatus", () => {
  test("reads every scope in one statement and fills the missing ones with zero", async () => {
    execute.mockResolvedValue({ rows: [{ scope: "global", used: "1200" }] });
    const status = await spendStatus(["global", "provider:openai"]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(status.map(({ scope, used, cap }) => ({ scope, used, cap }))).toEqual([
      { scope: "global", used: usd(1200), cap: usd(75_000_000) },
      { scope: "provider:openai", used: usd(0), cap: usd(14_000_000) },
    ]);
    expect(status[0]?.resetsAt).toEqual(status[1]?.resetsAt);
  });

  test("rejects a scope with no cap before touching the database", async () => {
    await expect(spendStatus(["pool:nobody"])).rejects.toBeInstanceOf(InvalidInputError);
    expect(withSystem).not.toHaveBeenCalled();
  });
});

describe("costOf", () => {
  test("sums in one statement and reads an empty result as zero", async () => {
    execute.mockResolvedValue({ rows: [{ total: "3100" }] });
    await expect(costOf("free_report", "r1")).resolves.toEqual(usd(3100));
    expect(params()).toEqual(["free_report", "r1"]);
    execute.mockResolvedValue({ rows: [] });
    await expect(costOf("free_report", "r2")).resolves.toEqual(usd(0));
  });
});
