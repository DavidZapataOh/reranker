import { randomUUID } from "node:crypto";
import { AppError } from "@reranker/schema";
import { type SQL, sql } from "drizzle-orm";
import pg from "pg";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type DbEvent, resetDbEventsForTest, setDbEventSink } from "./events";
import { asTenantId, type TenantTx, withSystem, withTenant } from "./tenancy";

type Script = (text: string) => Promise<unknown> | undefined;

// Stands in for pg.Pool: hands out clients whose statements follow a per-test script and
// records how each checkout ends.
class FakePool {
  checkedOut = 0;
  released: unknown[] = [];
  sent: string[] = [];
  private readonly script: Script;
  constructor(script: Script) {
    this.script = script;
  }
  async connect() {
    this.checkedOut++;
    let done = false;
    return {
      query: (query: string | { text: string }) => {
        const text = typeof query === "string" ? query : query.text;
        this.sent.push(text);
        return this.script(text) ?? Promise.resolve({ rows: [], rowCount: 0, fields: [] });
      },
      release: (error?: unknown) => {
        if (done) throw new Error("released twice");
        done = true;
        this.checkedOut--;
        this.released.push(error);
      },
    };
  }
}

const state = vi.hoisted(() => ({ pool: undefined as unknown }));
vi.mock("./client", () => ({
  appPool: () => state.pool,
  systemPool: () => state.pool,
}));

function pgError(code: string, message = "server detail"): pg.DatabaseError {
  const error = new pg.DatabaseError(message, 0, "error");
  error.code = code;
  return error;
}

const A = asTenantId(randomUUID());
const events: DbEvent[] = [];
const use = (script: Script) => {
  const pool = new FakePool(script);
  state.pool = pool;
  return pool;
};
const reject = (error: unknown) => Promise.reject(error);

beforeEach(() => setDbEventSink((event) => events.push(event)));
afterEach(() => {
  events.length = 0;
  resetDbEventsForTest();
});

test("a failed BEGIN translates the error and returns the slot, discarding the client", async () => {
  const failure = pgError("57P01");
  const pool = use((text) => (text.startsWith("begin") ? reject(failure) : undefined));
  await expect(withTenant(A, async () => 1)).rejects.toMatchObject({
    code: "service_unavailable",
    retryAfterSeconds: 2,
  });
  expect(pool.checkedOut).toBe(0);
  expect(pool.released).toHaveLength(1);
  expect(pool.released[0]).toBeTruthy();
});

test("when ROLLBACK fails the original error wins and the client is discarded", async () => {
  const pool = use((text) => {
    if (text.startsWith("insert")) return reject(pgError("42501"));
    if (text.startsWith("rollback")) return reject(new Error("Connection terminated unexpectedly"));
    return undefined;
  });
  const error = await withTenant(A, (tx) => tx.execute(sql`insert into app.t values (1)`)).catch(
    (e: unknown) => e,
  );
  expect(error).toMatchObject({ code: "internal", cause: { code: "42501" } });
  expect(events).toEqual([{ name: "db_rls_violation", pool: "app", pgCode: "42501" }]);
  expect(pool.checkedOut).toBe(0);
  expect(pool.released[0]).toBeTruthy();
});

test("a failed COMMIT is translated and the client is discarded", async () => {
  const pool = use((text) => (text.startsWith("commit") ? reject(pgError("08006")) : undefined));
  await expect(withSystem("jobs.lease", async () => 1)).rejects.toMatchObject({
    code: "service_unavailable",
  });
  expect(pool.released[0]).toBeTruthy();
});

test("a callback error after a clean ROLLBACK keeps the client and rethrows the same reference", async () => {
  const pool = use(() => undefined);
  const thrown = new AppError("not_found");
  await expect(
    withTenant(A, async () => {
      throw thrown;
    }),
  ).rejects.toBe(thrown);
  expect(pool.sent.map((t) => t.split(/\s/)[0])).toEqual(["begin", "select", "rollback"]);
  expect(pool.released).toEqual([undefined]);
});

test("a connection-class error inside the callback discards the client even after ROLLBACK", async () => {
  const pool = use((text) =>
    text.startsWith("select 1")
      ? reject(new Error("Connection terminated unexpectedly"))
      : undefined,
  );
  await expect(withTenant(A, (tx) => tx.execute(sql`select 1`))).rejects.toMatchObject({
    code: "service_unavailable",
  });
  expect(pool.released[0]).toBeTruthy();
});

test("success commits and returns the client to the pool", async () => {
  const pool = use(() => undefined);
  expect(await withTenant(A, async () => "ok", { statementTimeoutMs: 60_000 })).toBe("ok");
  expect(pool.sent.map((t) => t.split(/\s/)[0])).toEqual(["begin", "select", "commit"]);
  expect(pool.released).toEqual([undefined]);
});

test("the handle is unusable once the callback settles", async () => {
  const pool = use(() => undefined);
  let stored: TenantTx | undefined;
  let pending: PromiseLike<unknown> | undefined;
  await withTenant(A, async (tx) => {
    stored = tx;
    pending = tx.execute(sql`select 'late'`);
  });
  expect(() => stored?.execute(sql`select 2`)).toThrow(
    expect.objectContaining({ code: "internal" }),
  );
  expect(() => stored?.select()).toThrow(expect.objectContaining({ code: "internal" }));
  const late = await Promise.resolve(pending).catch((e: unknown) => e);
  expect((late as Error).cause ?? late).toMatchObject({ code: "internal" });
  expect(pool.sent.some((t) => t.includes("late") || t.includes("select 2"))).toBe(false);
});

test("the setup statement is a single round trip on the checked-out client", async () => {
  const seen: SQL[] = [];
  const pool = use(() => undefined);
  await withTenant(A, async () => seen.length);
  expect(pool.sent[1]).toMatch(
    /^select set_config\('app\.tenant_ids', \$1, true\), set_config\('statement_timeout', \$2, true\)$/,
  );
});
