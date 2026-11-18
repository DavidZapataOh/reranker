import { isAppError } from "@reranker/schema";
import type { GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createClientOrganization,
  createPrincipalTeam,
  hierarchyHooks,
  slugFor,
} from "./organizations";

const server = vi.hoisted(() => ({ auth: { api: { createOrganization: vi.fn() } } }));
vi.mock("./server", () => server);
const createOrganization = server.auth.api.createOrganization;

afterEach(() => {
  vi.resetAllMocks();
});

test.each([
  ["Panadería La Espiga", /^panaderia-la-espiga-[a-z0-9]{4}$/],
  ["   ", /^negocio-[a-z0-9]{4}$/],
  ["Ñandú & Cía. S.A.S.", /^nandu-cia-s-a-s-[a-z0-9]{4}$/],
  ["x".repeat(120), /^x{40}-[a-z0-9]{4}$/],
])("slugFor(%j)", (name, re) => expect(slugFor(name)).toMatch(re));

test("slugFor never ends the base in a dash after cutting it", () => {
  expect(slugFor(`${"a".repeat(39)} b`)).toMatch(/^a{39}-[a-z0-9]{4}$/);
});

test("slugFor gives the same name different suffixes", () => {
  const slugs = new Set(Array.from({ length: 20 }, () => slugFor("Mi negocio")));
  expect(slugs.size).toBeGreaterThan(1);
});

const user = {
  id: crypto.randomUUID(),
  email: "owner@example.com",
  emailVerified: true,
  name: "Owner",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const create = (organization: Record<string, unknown>) =>
  hierarchyHooks.beforeCreateOrganization({
    organization: { name: "Panadería", slug: "panaderia-ab12", countryCode: "CO", ...organization },
    user,
  });

async function rejection(promise: Promise<unknown>): Promise<APIError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof APIError)) throw new Error(`expected an APIError, got ${String(error)}`);
  return error;
}

describe("beforeCreateOrganization", () => {
  test.each([
    [{ kind: "agency" }, "agency_disabled"],
    [{ kind: "client", parentId: crypto.randomUUID() }, "parent_not_allowed"],
    [{ kind: "house", parentId: crypto.randomUUID() }, "parent_not_allowed"],
    [{ kind: "client", countryCode: "CU" }, "country_not_measurable"],
    [{ kind: "client", countryCode: "XX" }, "country_not_measurable"],
    [{ kind: "reseller" }, "invalid_kind"],
    [{}, "invalid_kind"],
  ])("%j is refused with %s", async (organization, reason) => {
    const error = await rejection(create(organization));
    expect(error.statusCode).toBe(400);
    expect(error.body).toMatchObject({ code: "validation_failed", message: reason });
  });
});

describe("beforeUpdateOrganization", () => {
  const member = {
    id: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    userId: user.id,
    role: "owner",
    createdAt: new Date(),
  };
  const update = (organization: Record<string, unknown>) =>
    hierarchyHooks.beforeUpdateOrganization({ organization, user, member });

  test.each([
    { kind: "agency" },
    { parentId: crypto.randomUUID() },
    { parentId: null },
    { countryCode: "MX" },
  ])("%j is refused", async (organization) => {
    const error = await rejection(update(organization));
    expect(error.statusCode).toBe(400);
    expect(error.body).toMatchObject({ code: "validation_failed", message: "immutable_field" });
  });

  test("a new name goes through", async () => {
    await expect(update({ name: "Panadería Nueva" })).resolves.toBeUndefined();
  });
});

describe("createPrincipalTeam", () => {
  const organization = {
    id: crypto.randomUUID(),
    name: "Panadería",
    slug: "panaderia-ab12",
    createdAt: new Date(),
  };

  test("creates the Principal team in the organization", async () => {
    const create = vi.fn(async ({ data }) => ({ id: crypto.randomUUID(), ...data }));
    const ctx = { context: { adapter: { create } } } as unknown as GenericEndpointContext;
    const team = await createPrincipalTeam(organization, ctx);
    expect(create).toHaveBeenCalledWith({
      model: "team",
      data: { name: "Principal", organizationId: organization.id, createdAt: expect.any(Date) },
    });
    expect(team).toMatchObject({ name: "Principal", organizationId: organization.id });
  });

  test("needs the endpoint context", async () => {
    await expect(createPrincipalTeam(organization)).rejects.toThrow();
  });
});

describe("createClientOrganization", () => {
  const input = {
    userId: crypto.randomUUID(),
    name: "Panadería La Espiga",
    countryCode: "CO" as const,
  };
  const id = "8F0C5E1A-3B5D-4C6E-9F7A-1B2C3D4E5F60";
  const slugTaken = () =>
    new APIError("BAD_REQUEST", {
      code: "ORGANIZATION_ALREADY_EXISTS",
      message: "Organization already exists",
    });

  async function appError(promise: Promise<unknown>) {
    const error = await promise.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    if (!isAppError(error)) throw new Error(`expected an AppError, got ${String(error)}`);
    return error;
  }

  test("creates a client for the user as a server call, keeping the active organization", async () => {
    createOrganization.mockImplementation(async ({ body }) => ({ id, slug: body.slug }));
    const created = await createClientOrganization(input);
    expect(createOrganization).toHaveBeenCalledExactlyOnceWith({
      body: {
        userId: input.userId,
        name: input.name,
        slug: expect.stringMatching(/^panaderia-la-espiga-[a-z0-9]{4}$/),
        kind: "client",
        countryCode: "CO",
        keepCurrentActiveOrganization: true,
      },
    });
    expect(created).toEqual({ id: id.toLowerCase(), slug: expect.stringMatching(/^panaderia/) });
  });

  test("a taken slug is drawn again", async () => {
    createOrganization
      .mockRejectedValueOnce(slugTaken())
      .mockRejectedValueOnce(slugTaken())
      .mockImplementation(async ({ body }) => ({ id, slug: body.slug }));
    await createClientOrganization(input);
    expect(createOrganization).toHaveBeenCalledTimes(3);
  });

  test("gives up after four taken slugs", async () => {
    createOrganization.mockRejectedValue(slugTaken());
    expect(await appError(createClientOrganization(input))).toMatchObject({ code: "internal" });
    expect(createOrganization).toHaveBeenCalledTimes(4);
  });

  test.each([
    [
      new APIError("BAD_REQUEST", { code: "validation_failed", message: "agency_disabled" }),
      "validation_failed",
      "agency_disabled",
    ],
    [
      new APIError("CONFLICT", { code: "conflict", message: "client_limit" }),
      "conflict",
      "client_limit",
    ],
    [new APIError("UNAUTHORIZED"), "internal", "internal"],
    [new Error("connection refused"), "internal", "internal"],
  ])("%s becomes AppError %s", async (thrown, code, message) => {
    createOrganization.mockRejectedValue(thrown);
    const error = await appError(createClientOrganization(input));
    expect(error).toMatchObject({ code, message, cause: thrown });
    expect(createOrganization).toHaveBeenCalledOnce();
  });
});
