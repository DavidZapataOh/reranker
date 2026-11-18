import { endPools, withSystem } from "@reranker/db";
import { members, organizations, users } from "@reranker/db/schema/auth";
import { isAppError } from "@reranker/schema";
import { APIError } from "better-auth/api";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { stubAuthEnv } from "../test/auth-server";

vi.mock("./send-auth-email", () => ({ sendAuthEmail: vi.fn() }));
stubAuthEnv();

const { auth } = await import("./server");
const { getHouseTenantId, provisionHouseOrganization } = await import("./house");
const { slugFor } = await import("./organizations");

// The tests run in file order: there is one house per database, so they share it.
const ownerEmail = `house-${crypto.randomUUID()}@example.com`;
let ownerId: string;
let houseId: string | undefined;
// A branch copied from one that already has a house hides it while this file runs.
let hidden: string[] = [];

const setKind = (ids: string[], kind: string) =>
  withSystem("test.house", (tx) =>
    tx.update(organizations).set({ kind }).where(inArray(organizations.id, ids)),
  );

beforeAll(async () => {
  hidden = await withSystem("test.setup", async (tx) => {
    const rows = await tx
      .update(organizations)
      .set({ kind: "client" })
      .where(eq(organizations.kind, "house"))
      .returning({ id: organizations.id });
    return rows.map((row) => row.id);
  });
  const [owner] = await withSystem("test.setup", (tx) =>
    tx
      .insert(users)
      .values({ name: "Fundador", email: ownerEmail, emailVerified: true })
      .returning({ id: users.id }),
  );
  if (!owner) throw new Error("user insert returned no row");
  ownerId = owner.id;
});

afterAll(async () => {
  try {
    await withSystem("test.cleanup", async (tx) => {
      if (houseId) await tx.delete(organizations).where(eq(organizations.id, houseId));
      await tx.delete(users).where(eq(users.email, ownerEmail));
    });
    if (hidden.length > 0) await setKind(hidden, "house");
  } finally {
    await endPools();
  }
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (reason: unknown) => reason,
  );
}

test("without a house getHouseTenantId fails, and the next call asks again", async () => {
  const error = await rejection(getHouseTenantId());
  expect(isAppError(error)).toBe(true);
  expect(error).toMatchObject({ code: "internal" });
});

test("provisioning for someone who never signed in is not_found", async () => {
  const error = await rejection(
    provisionHouseOrganization({ ownerEmail: `nobody-${crypto.randomUUID()}@example.com` }),
  );
  expect(isAppError(error)).toBe(true);
  expect(error).toMatchObject({ code: "not_found" });
});

test("provisioning creates the house owned by that user, once", async () => {
  const first = await provisionHouseOrganization({ ownerEmail: ownerEmail.toUpperCase() });
  houseId = first.id;
  const second = await provisionHouseOrganization({ ownerEmail });
  expect(second.id).toBe(first.id);

  const rows = await withSystem("test.read", async (tx) => ({
    houses: await tx.select().from(organizations).where(eq(organizations.kind, "house")),
    members: await tx.select().from(members).where(eq(members.organizationId, first.id)),
  }));
  expect(rows.houses).toEqual([
    expect.objectContaining({ id: first.id, kind: "house", name: "Reranker", parentId: null }),
  ]);
  expect(rows.members).toEqual([expect.objectContaining({ userId: ownerId, role: "owner" })]);
});

test("getHouseTenantId reads the house once per instance", async () => {
  if (!houseId) throw new Error("the house was not provisioned");
  expect(await getHouseTenantId()).toBe(houseId);
  await setKind([houseId], "client");
  try {
    expect(await getHouseTenantId()).toBe(houseId);
  } finally {
    await setKind([houseId], "house");
  }
});

test("a second house is refused", async () => {
  const error = await rejection(
    auth.api.createOrganization({
      body: {
        name: "Otra casa",
        slug: slugFor("Otra casa"),
        kind: "house",
        countryCode: "CO",
        userId: ownerId,
      },
    }),
  );
  expect(error).toBeInstanceOf(APIError);
  expect(error).toMatchObject({
    statusCode: 400,
    body: { code: "validation_failed", message: "second_house" },
  });
});
