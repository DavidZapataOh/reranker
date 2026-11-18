import { randomUUID } from "node:crypto";
import { AppError } from "@reranker/schema";
import { type SQL, sql } from "drizzle-orm";
import pg from "pg";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type DbEvent, resetDbEventsForTest, setDbEventSink } from "./events";
import { asTenantId, type TenantTx, withSystem, withTenant } from "./tenancy";

type Script = (text: string) => Promise<unknown> | undefined;

// Stands in for a pipelining pg.Pool: hands out clients whose statements follow a per-test
// script, answer on a later macrotask like a network would, and records how each checkout ends.
// A round trip is a run of statements written before any of them is answered.
class FakePool {
  checkedOut = 0;
  released: unknown[] = [];
  sent: string[] = [];
  roundTrips = 0;
  // What the server would report after the last statement; a test can pin it.
  status: "I" | "T" | "E" = "I";
  stuckInTransaction = false;
  readonly errorListeners = new Set<unknown>();
  private inFlight = 0;
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
        if (this.inFlight++ === 0) this.roundTrips++;
        if (text.startsWith("begin")) this.status = "T";
        if (/^(commit|rollback)/.test(text) && !this.stuckInTransaction) this.status = "I";
        return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
          this.inFlight--;
          return this.script(text) ?? { rows: [], rowCount: 0, fields: [] };
        });
      },
      getTransactionStatus: () => this.status,
      on: (event: string, listener: unknown) => {
        if (event === "error") this.errorListeners.add(listener);
      },
      removeListener: (event: string, listener: unknown) => {
        if (event === "error") this.errorListeners.delete(listener);
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
  const error = await withTenant(A, async (tx) => {
    await tx.execute(sql`insert into app.t values (1)`);
  }).catch((e: unknown) => e);
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

const kinds = (pool: FakePool) => pool.sent.map((t) => t.split(/\s/)[0]);

test("a callback returning one unawaited query is a single round trip, COMMIT included", async () => {
  const pool = use(() => undefined);
  await withSystem("jobs.lease", (tx) => tx.execute(sql`select 1`));
  expect(kinds(pool)).toEqual(["begin", "select", "select", "commit"]);
  expect(pool.roundTrips).toBe(1);
  expect(pool.released).toEqual([undefined]);
});

test("BEGIN and the settings travel with the first statement of an async callback", async () => {
  const pool = use(() => undefined);
  await withTenant(A, async (tx) => {
    await tx.execute(sql`select 1`);
    await tx.execute(sql`select 2`);
  });
  expect(kinds(pool)).toEqual(["begin", "select", "select", "select", "commit"]);
  // [begin, settings, select 1], [select 2], [commit]
  expect(pool.roundTrips).toBe(3);
});

test("a failing lone statement is rolled back by its COMMIT and keeps the client", async () => {
  const pool = use((text) => (text.startsWith("insert") ? reject(pgError("23505")) : undefined));
  await expect(
    withTenant(A, (tx) => tx.execute(sql`insert into app.t values (1)`)),
  ).rejects.toMatchObject({ code: "conflict", cause: { code: "23505" } });
  expect(kinds(pool)).toEqual(["begin", "select", "insert", "commit"]);
  expect(pool.released).toEqual([undefined]);
});

test("a failed setup statement wins over the error it causes downstream", async () => {
  const failure = pgError("22023");
  const pool = use((text) => {
    if (text.startsWith("select set_config")) return reject(failure);
    if (text.startsWith("select 1")) return reject(pgError("25P02"));
    return undefined;
  });
  const error = await withTenant(A, (tx) => tx.execute(sql`select 1`)).catch((e: unknown) => e);
  expect((error as Error).cause).toBe(failure);
  expect(pool.released).toEqual([undefined]);
});

test("what the callback throws wins over a statement of its own that failed first", async () => {
  use((text) => (text.startsWith("insert") ? reject(pgError("23505")) : undefined));
  const thrown = new Error("rollback sentinel");
  const error = await withSystem("test.setup", async (tx) => {
    await tx.execute(sql`insert into app.t values (1)`).catch(() => undefined);
    throw thrown;
  }).catch((e: unknown) => e);
  expect(error).toBe(thrown);
});

// A dead backend fails every query already on the wire; each of those promises must be handled
// even when it settles after the run has.
test.each([
  ["a lone query", (tx: TenantTx) => tx.execute(sql`select 1`)],
  ["an async callback", async (tx: TenantTx) => tx.execute(sql`select 1`)],
])("a backend that dies mid-pipeline under %s leaves no rejection unhandled", async (_, fn) => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    let died = false;
    const pool = use((text) => {
      if (text.startsWith("select 1")) died = true;
      return died ? reject(pgError("57P01")) : undefined;
    });
    await expect(withTenant(A, fn)).rejects.toMatchObject({ code: "service_unavailable" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
    expect(pool.released[0]).toBeTruthy();
  } finally {
    process.off("unhandledRejection", record);
  }
});

test("a client the server still reports inside a transaction is never reused", async () => {
  const pool = use(() => undefined);
  pool.stuckInTransaction = true;
  await withTenant(A, (tx) => tx.execute(sql`select 1`));
  expect(pool.released[0]).toBe(true);
});

test("the handle closes as soon as a lone statement's COMMIT is written", async () => {
  const pool = use(() => undefined);
  let stored: TenantTx | undefined;
  await withTenant(A, (tx) => {
    stored = tx;
    return tx.execute(sql`select 1`);
  });
  expect(() => stored?.execute(sql`select 2`)).toThrow(
    expect.objectContaining({ code: "internal" }),
  );
  expect(kinds(pool)).toEqual(["begin", "select", "select", "commit"]);
});

test("a statement queued on the microtask queue cannot slip in ahead of a lone query's COMMIT", async () => {
  const pool = use(() => undefined);
  let late: unknown;
  const keep = (e: unknown) => {
    late = e;
  };
  await withTenant(A, (tx) => {
    void Promise.resolve()
      .then(() => tx.execute(sql`insert into app.t values (1)`).then(undefined, keep))
      .catch(keep);
    return tx.execute(sql`select 1`);
  });
  expect(late).toMatchObject({ code: "internal" });
  expect(kinds(pool)).toEqual(["begin", "select", "select", "commit"]);
});

test("a lone query that writes nothing synchronously gets COMMIT only after it settles", async () => {
  const pool = use(() => undefined);
  await withTenant(A, (tx) => {
    const lazy = tx.execute(sql`select 1`);
    const then = lazy.then.bind(lazy);
    // Stands in for a driver that defers the write past the call to then().
    vi.spyOn(lazy, "then").mockImplementation(((onFulfilled, onRejected) =>
      Promise.resolve().then(() => then(onFulfilled, onRejected))) as typeof lazy.then);
    return lazy;
  });
  expect(kinds(pool)).toEqual(["begin", "select", "select", "commit"]);
  expect(pool.roundTrips).toBe(2);
});

test("the client listens for connection errors only while it is checked out", async () => {
  const pool = use(() => undefined);
  let during = 0;
  await withTenant(A, async (tx) => {
    during = pool.errorListeners.size;
    await tx.execute(sql`select 1`);
  });
  expect(during).toBe(1);
  expect(pool.errorListeners.size).toBe(0);
});

test("isolation and access mode reach BEGIN, and an unknown isolation never does", async () => {
  const pool = use(() => undefined);
  await withSystem("jobs.network", async () => 1, { isolation: "serializable", readOnly: true });
  expect(pool.sent[0]).toBe("begin isolation level serializable read only");
  await expect(
    withSystem("jobs.network", async () => 1, {
      isolation: "read uncommitted; drop table x" as "serializable",
    }),
  ).rejects.toMatchObject({ code: "internal" });
  expect(pool.checkedOut).toBe(0);
  expect(pool.sent).toHaveLength(3);
});
