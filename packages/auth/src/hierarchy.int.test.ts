import { endPools, withSystem } from "@reranker/db";
import { members, organizations, teamMembers, teams, users } from "@reranker/db/schema/auth";
import { isAppError } from "@reranker/schema";
import { APIError } from "better-auth/api";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, test, vi } from "vitest";
import { ORIGIN, signInWithCode, stubAuthEnv } from "../test/auth-server";

// Nothing has to reach an inbox: the code is read from the database.
vi.mock("./send-auth-email", () => ({ sendAuthEmail: vi.fn() }));
stubAuthEnv();

const { auth } = await import("./server");
const { createClientOrganization, slugFor } = await import("./organizations");

const userIds: string[] = [];

afterAll(async () => {
  // Deleting the users cascades to their memberships; the organizations go by owner.
  await withSystem("test.cleanup", async (tx) => {
    if (userIds.length === 0) return;
    const owned = await tx
      .select({ id: members.organizationId })
      .from(members)
      .where(inArray(members.userId, userIds));
    if (owned.length > 0) {
      await tx.delete(organizations).where(
        inArray(
          organizations.id,
          owned.map((row) => row.id),
        ),
      );
    }
    await tx.delete(users).where(inArray(users.id, userIds));
  });
  await endPools();
});

async function newUser(): Promise<string> {
  const [row] = await withSystem("test.setup", (tx) =>
    tx
      .insert(users)
      .values({
        name: "Dueño",
        email: `hierarchy-${crypto.randomUUID()}@example.com`,
        emailVerified: true,
      })
      .returning({ id: users.id }),
  );
  if (!row) throw new Error("user insert returned no row");
  userIds.push(row.id);
  return row.id;
}

async function signedInUser(): Promise<{ userId: string; cookie: string }> {
  const session = await signInWithCode(
    auth,
    `delivered+hierarchy-${crypto.randomUUID()}@resend.dev`,
  );
  userIds.push(session.userId);
  return session;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (reason: unknown) => reason,
  );
}

async function createdWith(organization: Record<string, unknown>): Promise<unknown> {
  const userId = await newUser();
  return rejection(
    auth.api.createOrganization({
      body: {
        name: "Negocio",
        slug: slugFor("Negocio"),
        kind: "client",
        countryCode: "CO",
        userId,
        ...organization,
      },
    }),
  );
}

describe("creating an organization on the server", () => {
  test.each([
    [{ kind: "agency" }, "agency_disabled"],
    [{ parentId: crypto.randomUUID() }, "parent_not_allowed"],
    [{ countryCode: "CU" }, "country_not_measurable"],
    [{ countryCode: "XX" }, "country_not_measurable"],
    [{ kind: "reseller" }, "invalid_kind"],
  ])("%j is refused with %s", async (organization, reason) => {
    const error = await createdWith(organization);
    expect(error).toBeInstanceOf(APIError);
    expect(error).toMatchObject({
      statusCode: 400,
      body: { code: "validation_failed", message: reason },
    });
  });

  test("any measurable country is accepted, launched or not", async () => {
    const userId = await newUser();
    const created = await createClientOrganization({ userId, name: "Taquería", countryCode: "MX" });
    const [row] = await withSystem("test.read", (tx) =>
      tx
        .select({ countryCode: organizations.countryCode })
        .from(organizations)
        .where(eq(organizations.id, created.id)),
    );
    expect(row?.countryCode).toBe("MX");
  });
});

describe("createClientOrganization", () => {
  test("creates a client with one Principal team holding its owner", async () => {
    const userId = await newUser();
    const created = await createClientOrganization({
      userId,
      name: "Panadería La Espiga",
      countryCode: "CO",
    });
    expect(created.slug).toMatch(/^panaderia-la-espiga-[a-z0-9]{4}$/);

    const rows = await withSystem("test.read", async (tx) => ({
      organization: await tx.select().from(organizations).where(eq(organizations.id, created.id)),
      members: await tx.select().from(members).where(eq(members.organizationId, created.id)),
      teams: await tx.select().from(teams).where(eq(teams.organizationId, created.id)),
    }));
    expect(rows.organization).toEqual([
      expect.objectContaining({
        kind: "client",
        parentId: null,
        countryCode: "CO",
        slug: created.slug,
      }),
    ]);
    expect(rows.members).toEqual([
      expect.objectContaining({ userId, role: "owner", source: "direct" }),
    ]);
    expect(rows.teams).toEqual([expect.objectContaining({ name: "Principal" })]);
    const teamRows = await withSystem("test.read", (tx) =>
      tx
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.teamId, rows.teams[0]?.id ?? "")),
    );
    expect(teamRows).toEqual([expect.objectContaining({ userId })]);
  });

  test("a second client for the same owner is a conflict", async () => {
    const userId = await newUser();
    await createClientOrganization({ userId, name: "Primero", countryCode: "CO" });
    const error = await rejection(
      createClientOrganization({ userId, name: "Segundo", countryCode: "CO" }),
    );
    expect(isAppError(error)).toBe(true);
    expect(error).toMatchObject({ code: "conflict" });
  });

  test("a refused hierarchy rule surfaces as the same AppError code", async () => {
    const userId = await newUser();
    const error = await rejection(
      createClientOrganization({ userId, name: "Sin país", countryCode: "CU" as "CO" }),
    );
    expect(isAppError(error)).toBe(true);
    expect(error).toMatchObject({ code: "validation_failed", message: "country_not_measurable" });
  });
});

describe("updating an organization", () => {
  test.each([{ kind: "agency" }, { parentId: crypto.randomUUID() }, { countryCode: "MX" }])(
    "%j is refused",
    async (data) => {
      const { userId, cookie } = await signedInUser();
      const { id } = await createClientOrganization({ userId, name: "Negocio", countryCode: "CO" });
      const error = await rejection(
        auth.api.updateOrganization({
          headers: new Headers({ cookie }),
          body: { organizationId: id, data },
        }),
      );
      expect(error).toMatchObject({
        statusCode: 400,
        body: { code: "validation_failed", message: "immutable_field" },
      });
    },
  );

  test("a new name is saved", async () => {
    const { userId, cookie } = await signedInUser();
    const { id } = await createClientOrganization({ userId, name: "Negocio", countryCode: "CO" });
    const updated = await auth.api.updateOrganization({
      headers: new Headers({ cookie }),
      body: { organizationId: id, data: { name: "Negocio Nuevo" } },
    });
    expect(updated).toMatchObject({ id, name: "Negocio Nuevo", kind: "client", countryCode: "CO" });
  });
});

test("a signed-in user cannot create organizations over HTTP", async () => {
  const { cookie } = await signedInUser();
  const response = await auth.handler(
    new Request(`${ORIGIN}/api/auth/organization/create`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({
        name: "Propio",
        slug: slugFor("Propio"),
        kind: "client",
        countryCode: "CO",
      }),
    }),
  );
  expect(response.status).toBe(403);
});
