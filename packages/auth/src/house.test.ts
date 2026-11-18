import { isAppError } from "@reranker/schema";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Each withSystem call answers with the next queued rows; the queries themselves run in
// house.int.test.ts.
const db = vi.hoisted(() => ({ rows: [] as unknown[][], withSystem: vi.fn() }));
vi.mock("@reranker/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/db")>()),
  withSystem: db.withSystem,
}));
const server = vi.hoisted(() => ({ auth: { api: { createOrganization: vi.fn() } } }));
vi.mock("./server", () => server);

const HOUSE = "0b5e7c1e-4a8f-4d0b-9a6e-2f3c4d5e6f70";
const OWNER = "5f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";

let house: typeof import("./house");

beforeEach(async () => {
  db.rows = [];
  db.withSystem.mockImplementation(async () => db.rows.shift() ?? []);
  vi.resetModules();
  house = await import("./house");
});

afterEach(() => {
  vi.resetAllMocks();
});

async function appError(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!isAppError(error)) throw new Error(`expected an AppError, got ${String(error)}`);
  return error;
}

describe("provisionHouseOrganization", () => {
  test("an address that never signed in is not_found", async () => {
    db.rows = [[]];
    expect(
      await appError(house.provisionHouseOrganization({ ownerEmail: "x@example.com" })),
    ).toMatchObject({ code: "not_found" });
    expect(server.auth.api.createOrganization).not.toHaveBeenCalled();
  });

  test("an existing house is returned without creating another", async () => {
    db.rows = [[{ id: OWNER }], [{ id: HOUSE }]];
    expect(await house.provisionHouseOrganization({ ownerEmail: "f@example.com" })).toEqual({
      id: HOUSE,
      created: false,
    });
    expect(server.auth.api.createOrganization).not.toHaveBeenCalled();
  });

  test("creates the Reranker house owned by that user", async () => {
    db.rows = [[{ id: OWNER }], []];
    server.auth.api.createOrganization.mockResolvedValue({ id: HOUSE });
    expect(await house.provisionHouseOrganization({ ownerEmail: " F@Example.com " })).toEqual({
      id: HOUSE,
      created: true,
    });
    expect(server.auth.api.createOrganization).toHaveBeenCalledExactlyOnceWith({
      body: {
        userId: OWNER,
        name: "Reranker",
        slug: expect.stringMatching(/^reranker-[a-z0-9]{4}$/),
        kind: "house",
        countryCode: "CO",
        keepCurrentActiveOrganization: true,
      },
    });
  });
});

describe("getHouseTenantId", () => {
  test("reads the house once per instance", async () => {
    db.rows = [[{ id: HOUSE }]];
    expect(await house.getHouseTenantId()).toBe(HOUSE);
    expect(await house.getHouseTenantId()).toBe(HOUSE);
    expect(db.withSystem).toHaveBeenCalledOnce();
  });

  test("concurrent first calls share one read", async () => {
    db.rows = [[{ id: HOUSE }]];
    expect(await Promise.all([house.getHouseTenantId(), house.getHouseTenantId()])).toEqual([
      HOUSE,
      HOUSE,
    ]);
    expect(db.withSystem).toHaveBeenCalledOnce();
  });

  test("a missing house is internal, and the next call reads again", async () => {
    db.rows = [[], [{ id: HOUSE }]];
    expect(await appError(house.getHouseTenantId())).toMatchObject({ code: "internal" });
    expect(await house.getHouseTenantId()).toBe(HOUSE);
    expect(db.withSystem).toHaveBeenCalledTimes(2);
  });

  test("a failed read is not remembered", async () => {
    db.withSystem.mockRejectedValueOnce(new Error("connection refused"));
    db.rows = [[{ id: HOUSE }]];
    await expect(house.getHouseTenantId()).rejects.toThrow("connection refused");
    expect(await house.getHouseTenantId()).toBe(HOUSE);
  });
});
