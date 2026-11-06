export type TenantSeed = { id: string; name: string; slug: string };

export function newTenantSeed(overrides: Partial<TenantSeed> = {}): TenantSeed {
  const id = crypto.randomUUID();
  const short = id.slice(0, 8);
  return { id, name: `Tenant ${short}`, slug: `tenant-${short}`, ...overrides };
}
