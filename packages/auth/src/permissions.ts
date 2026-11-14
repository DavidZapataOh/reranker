import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

export const statements = {
  ...defaultStatements,
  workspace: ["create", "update", "delete"],
  business: ["create", "read", "update", "delete"],
  report: ["create", "read", "share"],
  fix: ["create", "approve"],
  lead: ["read", "export"],
  billing: ["read", "manage"],
  // Only meaningful in organizations of kind 'agency'.
  client: ["create", "read", "delete"],
  whiteLabel: ["manage"],
} as const;

export const ac = createAccessControl(statements);

export const roles = {
  owner: ac.newRole(statements),
  admin: ac.newRole({
    ...statements,
    organization: ["update"],
    billing: ["read"],
  }),
  member: ac.newRole({
    business: ["create", "read", "update"],
    report: ["create", "read", "share"],
    fix: ["create"],
    lead: ["read"],
    client: ["read"],
  }),
  viewer: ac.newRole({
    business: ["read"],
    report: ["read"],
    lead: ["read"],
  }),
};

export type Role = keyof typeof roles;

export type PermissionRequest = Partial<{
  [K in keyof typeof statements]: ReadonlyArray<(typeof statements)[K][number]>;
}>;

export function authorize(role: Role, permissions: PermissionRequest): boolean {
  return roles[role].authorize(permissions).success;
}
