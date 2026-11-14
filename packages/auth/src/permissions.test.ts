import { describe, expect, test } from "vitest";
import { authorize, type PermissionRequest, type Role, roles, statements } from "./permissions";

const grants: Record<Exclude<Role, "owner" | "admin">, Record<string, readonly string[]>> = {
  member: {
    business: ["create", "read", "update"],
    report: ["create", "read", "share"],
    fix: ["create"],
    lead: ["read"],
    client: ["read"],
  },
  viewer: { business: ["read"], report: ["read"], lead: ["read"] },
};

const expected: Record<Role, (resource: string, action: string) => boolean> = {
  owner: () => true,
  admin: (resource, action) =>
    !(resource === "organization" && action === "delete") &&
    !(resource === "billing" && action === "manage"),
  member: (resource, action) => grants.member[resource]?.includes(action) ?? false,
  viewer: (resource, action) => grants.viewer[resource]?.includes(action) ?? false,
};

const cases = (Object.keys(roles) as Role[]).flatMap((role) =>
  Object.entries(statements).flatMap(([resource, actions]) =>
    actions.map((action) => [role, resource, action] as const),
  ),
);

describe("access control", () => {
  test.each(cases)("%s on %s:%s", (role, resource, action) => {
    const request = { [resource]: [action] } as PermissionRequest;
    expect(authorize(role, request)).toBe(expected[role](resource, action));
  });

  test("statements extend the Better Auth defaults with the product resources", () => {
    expect(Object.keys(statements)).toEqual(
      expect.arrayContaining([
        "organization",
        "member",
        "invitation",
        "team",
        "ac",
        "workspace",
        "business",
        "report",
        "fix",
        "lead",
        "billing",
        "client",
        "whiteLabel",
      ]),
    );
  });

  test("a request needs every permission it lists", () => {
    expect(authorize("member", { report: ["read", "share"] })).toBe(true);
    expect(authorize("member", { report: ["read", "share"], billing: ["read"] })).toBe(false);
    expect(authorize("viewer", { report: ["read", "share"] })).toBe(false);
  });

  test("an empty request is denied, so a missing permission never grants access", () => {
    for (const role of Object.keys(roles) as Role[]) expect(authorize(role, {})).toBe(false);
  });
});
