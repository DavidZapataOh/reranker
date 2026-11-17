import { DEFAULT_COUNTRY_CODE } from "@reranker/i18n/countries";
import { organizations } from "../src/schema";
import { asTenantId, type SystemTx, type TenantId } from "../src/tenancy";

export type TenantSeed = { id: string; name: string; slug: string };

export function newTenantSeed(overrides: Partial<TenantSeed> = {}): TenantSeed {
  const id = crypto.randomUUID();
  const short = id.slice(0, 8);
  return { id, name: `Tenant ${short}`, slug: `tenant-${short}`, ...overrides };
}

/** Inserts an organization (the tenant) with no user or members; `createdAt` is set by Better Auth in the app. */
export async function createTenant(
  tx: SystemTx,
  overrides: { kind?: "house" | "client"; name?: string } = {},
): Promise<TenantId> {
  const seed = newTenantSeed();
  const [row] = await tx
    .insert(organizations)
    .values({
      id: seed.id,
      name: overrides.name ?? seed.name,
      slug: seed.slug,
      kind: overrides.kind ?? "client",
      countryCode: DEFAULT_COUNTRY_CODE,
      createdAt: new Date(),
    })
    .returning({ id: organizations.id });
  if (!row) throw new Error("organization insert returned no row");
  return asTenantId(row.id);
}
