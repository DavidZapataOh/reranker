import { randomUUID } from "node:crypto";
import { AppError } from "@reranker/schema";
import { DatabaseError } from "pg";
import { beforeEach, expect, test, vi } from "vitest";

// The real transaction path runs in test/tenancy.int.test.ts against Neon. This double stands in
// for a pooled pg client to pin the statements sent, the pool used and how the client goes back.
type Step = { text: string; params: unknown[] };

class FakeClient {
  readonly steps: Step[] = [];
  released: boolean | Error | undefined;
  failOn: { pattern: RegExp; error: Error } | undefined;

  async query(config: string | { text: string }, params: unknown[] = []) {
    const text = typeof config === "string" ? config : config.text;
    this.steps.push({ text, params });
    if (this.failOn?.pattern.test(text)) throw this.failOn.error;
    return { rows: [], fields: [], rowCount: 0, command: "SELECT" };
  }

  release(destroy?: boolean | Error) {
    this.released = destroy;
  }
}

const checkouts: { kind: string; client: FakeClient }[] = [];
let nextClient = new FakeClient();
let connectError: Error | undefined;

vi.mock("./client.ts", () => ({
  pool: (kind: string) => ({
    async connect() {
      if (connectError !== undefined) throw connectError;
      checkouts.push({ kind, client: nextClient });
      return nextClient;
    },
  }),
}));

const { asTenantId, withSystem, withTenant, withTenants } = await import("./tenancy.ts");

const A = asTenantId(randomUUID());
const B = asTenantId(randomUUID());
const serverError = (code: string) =>
  Object.assign(new DatabaseError(`pg ${code}`, 0, "error"), { code });

beforeEach(() => {
  checkouts.length = 0;
  nextClient = new FakeClient();
  connectError = undefined;
});

test("withTenants sends begin, one set_config with the ids and timeout, then commit", async () => {
  await expect(withTenants([A, B], async () => "done")).resolves.toBe("done");
  expect(checkouts.map(({ kind }) => kind)).toEqual(["app"]);
  expect(nextClient.steps).toEqual([
    { text: "begin", params: [] },
    {
      text: "select set_config('app.tenant_ids', $1, true), set_config('statement_timeout', $2, true)",
      params: [`{${A},${B}}`, "5000"],
    },
    { text: "commit", params: [] },
  ]);
  expect(nextClient.released).toBe(false);
});

test("withSystem uses the system pool, sets its reason and applies transaction options", async () => {
  await withSystem("jobs.lease", async () => undefined, {
    readOnly: true,
    isolation: "repeatable read",
    statementTimeoutMs: 250,
  });
  expect(checkouts.map(({ kind }) => kind)).toEqual(["system"]);
  expect(nextClient.steps.map((step) => step.text)).toEqual([
    "begin isolation level repeatable read read only",
    "select set_config('app.system_reason', $1, true), set_config('statement_timeout', $2, true)",
    "commit",
  ]);
  expect(nextClient.steps[1]?.params).toEqual(["jobs.lease", "250"]);
});

test("a failed BEGIN destroys the client instead of keeping the pool slot", async () => {
  nextClient.failOn = { pattern: /^begin/, error: new Error("Connection terminated unexpectedly") };
  await expect(withTenant(A, async () => 1)).rejects.toMatchObject({
    code: "service_unavailable",
  });
  expect(nextClient.released).toBe(true);
});

test("a server error inside the body rolls back and returns the clean client", async () => {
  const rls = serverError("42501");
  nextClient.failOn = { pattern: /^select set_config/, error: rls };
  await expect(withSystem("auth", async () => 1)).rejects.toMatchObject({
    code: "internal",
    cause: rls,
  });
  expect(nextClient.steps.at(-1)?.text).toBe("rollback");
  expect(nextClient.released).toBe(false);
});

test("an AppError from the callback rolls back, keeps the client and comes out unchanged", async () => {
  const thrown = new AppError("not_found");
  await expect(
    withTenant(A, async () => {
      throw thrown;
    }),
  ).rejects.toBe(thrown);
  expect(nextClient.steps.at(-1)?.text).toBe("rollback");
  expect(nextClient.released).toBe(false);
});

test("a ROLLBACK lost with the connection destroys the client", async () => {
  nextClient.failOn = {
    pattern: /^rollback/,
    error: new Error("Connection terminated unexpectedly"),
  };
  await expect(
    withTenant(A, async () => {
      throw new AppError("not_found");
    }),
  ).rejects.toMatchObject({ code: "service_unavailable" });
  expect(nextClient.released).toBe(true);
});

test("a serialization failure at COMMIT keeps the client, which Postgres left usable", async () => {
  nextClient.failOn = { pattern: /^commit/, error: serverError("40001") };
  await expect(withTenant(A, async () => 1)).rejects.toMatchObject({ code: "internal" });
  expect(nextClient.released).toBe(false);
});

test("a pool that cannot hand out a client answers service_unavailable", async () => {
  connectError = new Error("timeout exceeded when trying to connect");
  await expect(withTenant(A, async () => 1)).rejects.toMatchObject({
    code: "service_unavailable",
    retryAfterSeconds: 2,
  });
  expect(checkouts).toEqual([]);
});
